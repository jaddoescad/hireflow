import "server-only";
import { adminDb } from "./supabase/server";
import type { Interview } from "./interviews";
import { planRecorder, recallState, recorderName, recorderProblem } from "./recorder";

// Recall.ai sends the meeting bot that records interviews. Keys are regional; set the matching base URL.
export function recorderAvailable() {
  return !!process.env.RECALL_API_KEY;
}
class RecallError extends Error {
  constructor(readonly status: number) { super(`Recall request failed (${status})`); }
}
async function recall<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const base = new URL(process.env.RECALL_API_URL || "https://us-east-1.recall.ai");
  if (base.protocol !== "https:" || !base.hostname.endsWith(".recall.ai")) throw new Error("RECALL_API_URL must be a recall.ai URL.");
  const response = await fetch(`${base.origin}/api/v1${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new RecallError(response.status);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}
function recallProblem(error: unknown) {
  const status = error instanceof RecallError ? error.status : 0;
  return status === 401 || status === 403 ? "Recall rejected the API key. Check RECALL_API_KEY and RECALL_API_URL."
    : status === 507 ? "Recall has no recorder free right now. HireFlow will try again in a few minutes."
    : status === 400 ? "Recall could not book a recorder for this Meet link."
    : "Could not reach Recall to book the recorder. HireFlow will try again in a few minutes.";
}

export type Bot = {
  id: string; join_at?: string | null;
  status_changes?: { code: string; sub_code?: string | null; created_at: string }[];
  recordings?: {
    started_at?: string | null; completed_at?: string | null;
    media_shortcuts?: { video_mixed?: { status?: { code?: string } | null; data?: { download_url?: string | null } | null } | null } | null;
  }[];
};
export const getBot = (id: string) => recall<Bot>(`/bot/${encodeURIComponent(id)}/`);
export async function deleteBotMedia(id: string) {
  await recall(`/bot/${encodeURIComponent(id)}/delete_media/`, "POST");
}
// A booked bot is deleted; one already launching is told to leave, and its status then arrives as usual.
// Returns false when neither worked, or the bot's last status when it had already finished.
type Status = NonNullable<Bot["status_changes"]>[number];
async function cancelBot(id: string): Promise<"deleted" | "left" | false | Status> {
  try { await recall(`/bot/${encodeURIComponent(id)}/`, "DELETE"); return "deleted"; }
  catch (e) { if (e instanceof RecallError && e.status === 404) return "deleted"; }
  try { await recall(`/bot/${encodeURIComponent(id)}/leave_call/`, "POST"); return "left"; }
  catch { /* It may have finished already. */ }
  try {
    const last = (await getBot(id)).status_changes?.at(-1);
    return last && ["call_ended", "done", "fatal"].includes(last.code) ? last : false;
  } catch { return false; }
}

// Books, moves or cancels the recorder for one interview, and sends one to a meeting it has not visited.
// Without recording storage the videos could not be saved, so no recorder is booked.
export async function scheduleRecorder(session: Interview, meetUrl: string | null, liveSince: string | null, storage: boolean) {
  if (!recorderAvailable()) return;
  const db = adminDb();
  const scope = { company_id: session.company_id, interview_id: session.id };
  const { data: visits, error } = await db.from("hf_interview_recordings").select("name,state,planned_start,join_at,meet_url,created_at,status_at")
    .eq("company_id", session.company_id).eq("interview_id", session.id);
  if (error) throw new Error("Could not load recorder visits.");
  const plan = planRecorder({
    starts_at: session.starts_at, ends_at: session.ends_at,
    wanted: storage && session.auto_record && session.status !== "cancelled" && !session.cancel_requested,
  }, visits, meetUrl, liveSince);
  let problem: string | null = null;
  let cleared = true;
  for (const name of plan.cancel) {
    const result = await cancelBot(name);
    if (result === "deleted") {
      await db.from("hf_interview_recordings").update({ state: "cancelled", updated_at: new Date().toISOString() })
        .eq("company_id", session.company_id).eq("name", name).eq("state", "scheduled");
    } else if (result && result !== "left") {
      // It already visited, so keep what it recorded.
      await applyRecorderStatus(session.company_id, name, result.code, result.sub_code, result.created_at);
    } else if (!result) {
      cleared = false;
      problem = "Could not cancel the booked recorder. HireFlow will try again.";
      // A cancelled interview is not synced again, so the scheduled cleanup keeps trying.
      if (!plan.create) await db.from("hf_recorder_cancellations").upsert({ bot: name, company_id: session.company_id }, { ignoreDuplicates: true });
    }
  }
  // A replaced recorder must be gone first so two never arrive together.
  if (plan.create && cleared && meetUrl) {
    try {
      // A booking whose reply was lost still exists at Recall; adopt it instead of booking a second recorder.
      const known = new Set((visits as { name: string }[]).map(v => v.name));
      const lost = (await recall<{ results?: Bot[] }>(`/bot/?${new URLSearchParams({
        metadata__company_id: session.company_id, metadata__interview_id: session.id })}`)).results?.filter(b => !known.has(b.id)) || [];
      const bots = lost.length ? lost : [await recall<Bot>("/bot/", "POST", {
        meeting_url: meetUrl, bot_name: recorderName,
        ...(plan.create.join_at ? { join_at: plan.create.join_at } : {}),
        recording_config: { video_mixed_mp4: {} },
        automatic_leave: {
          waiting_room_timeout: 600, noone_joined_timeout: 600,
          everyone_left_timeout: { timeout: 600, activate_after: 0 },
        },
        metadata: scope,
      })];
      for (const bot of bots) {
        const saved = await db.from("hf_interview_recordings").insert({
          ...scope, name: bot.id, state: "scheduled", planned_start: plan.create.planned_start,
          join_at: bot.join_at || plan.create.join_at, meet_url: meetUrl,
        });
        if (saved.error) throw new Error("Could not save the booked recorder.");
        const last = bot.status_changes?.at(-1);
        if (last) await applyRecorderStatus(session.company_id, bot.id, last.code, last.sub_code, last.created_at);
      }
    } catch (e) { problem = recallProblem(e); }
  }
  if (problem !== session.recorder_error)
    await db.from("hf_interviews").update({ recorder_error: problem }).eq("company_id", session.company_id).eq("id", session.id);
}

// Applies one bot status; older and repeated statuses are ignored by the database.
export async function applyRecorderStatus(company: string, bot: string, code: string, subCode: string | null | undefined, at: string) {
  const { error } = await adminDb().rpc("hf_recording_status", {
    cid: company, bot, next_state: recallState(code), status_time: at, problem: recorderProblem(code, subCode),
  });
  if (error) throw new Error("Could not save the recorder status.");
}

// Webhooks are the fast path; this catches up on recorders whose status has not changed for 10 minutes.
export async function reconcileRecorders(deadline: number) {
  if (!recorderAvailable()) return 0;
  const db = adminDb();
  const now = new Date().toISOString();
  const { data, error } = await db.from("hf_interview_recordings").select("company_id,name")
    .in("state", ["scheduled", "joining", "waiting", "recording", "processing"])
    .lt("updated_at", new Date(Date.now() - 600000).toISOString())
    .or(`join_at.is.null,join_at.lt.${now}`).order("updated_at").limit(20);
  if (error) throw new Error("Could not load recorders to check.");
  let checked = 0;
  for (const row of data) {
    if (Date.now() > deadline) break;
    try {
      const last = (await getBot(row.name)).status_changes?.at(-1);
      await applyRecorderStatus(row.company_id, row.name, last?.code || "", last?.sub_code, last?.created_at || now);
      checked++;
    } catch (e) {
      if (e instanceof RecallError && e.status === 404)
        await applyRecorderStatus(row.company_id, row.name, "fatal", null, now);
    }
  }
  return checked;
}

// Recorders of deleted interviews, candidates or companies are cancelled so they do not join.
export async function cancelDeletedRecorders(deadline: number) {
  if (!recorderAvailable()) return 0;
  const db = adminDb();
  const { data, error } = await db.from("hf_recorder_cancellations").select("bot,company_id").order("created_at").limit(20);
  if (error) throw new Error("Could not load recorders to cancel.");
  let done = 0;
  for (const { bot, company_id } of data) {
    if (Date.now() > deadline) break;
    const result = await cancelBot(bot);
    if (!result) continue;
    if (result === "deleted") await db.from("hf_interview_recordings").update({ state: "cancelled", updated_at: new Date().toISOString() })
      .eq("company_id", company_id).eq("name", bot).eq("state", "scheduled");
    await db.from("hf_recorder_cancellations").delete().eq("bot", bot);
    done++;
  }
  return done;
}

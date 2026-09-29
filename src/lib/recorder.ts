import type { Interview, Recording, RecordingState } from "./interviews";

// Interviews are recorded by a Recall.ai meeting bot that asks to join the Meet call like a guest.
export const recorderName = "HireFlow Recorder";
// Recall guarantees on-time arrival only for bots booked more than 10 minutes ahead; closer bots are sent right away.
const bookingLead = 11 * 60000;
const joinEarly = 60000;
const maxVisits = 5;

export function recorderJoinAt(startsAt: string, now = Date.now()) {
  const at = Date.parse(startsAt) - joinEarly;
  return at - now > bookingLead ? new Date(at).toISOString() : null;
}
// A recorder is sent from 15 minutes before the start until 2 hours after the scheduled end.
export function recorderWindowOpen(session: Pick<Interview, "starts_at" | "ends_at">, now = Date.now()) {
  return Date.parse(session.starts_at) - 15 * 60000 <= now && now <= Date.parse(session.ends_at) + 2 * 3600000;
}
export function recorderInCall(state: RecordingState) {
  return state === "joining" || state === "waiting" || state === "recording";
}

const states: Record<string, RecordingState> = {
  joining_call: "joining", in_waiting_room: "waiting", in_call_not_recording: "joining",
  recording_permission_allowed: "joining", in_call_recording: "recording",
  call_ended: "processing", done: "done", fatal: "failed",
};
// Maps a Recall bot status code to a recording state; other codes do not change it.
export function recallState(code: string): RecordingState | null {
  return Object.hasOwn(states, code) ? states[code] : null;
}
const problems: Record<string, string> = {
  timeout_exceeded_waiting_room: `Nobody let ${recorderName} into the call.`,
  bot_kicked_from_waiting_room: `${recorderName} was denied entry to the call.`,
  bot_kicked_from_call: `${recorderName} was removed from the call.`,
  timeout_exceeded_noone_joined: "Nobody else joined the call.",
  meeting_not_found: "The Meet link was not found.",
  meeting_link_expired: "The Meet link has expired.",
  meeting_requires_sign_in: "The Meet room only allows signed-in accounts.",
};
export function recorderProblem(code: string, subCode?: string | null) {
  if (subCode && Object.hasOwn(problems, subCode)) return problems[subCode];
  return code === "fatal" ? `${recorderName} could not record this meeting.` : null;
}

type Visit = Pick<Recording, "name" | "state" | "planned_start" | "join_at" | "created_at"> & { meet_url: string | null; status_at: string | null };
export type RecorderPlan = { cancel: string[]; create: { join_at: string | null; planned_start: string } | null };
// Decides which recorder visits to cancel and whether to send one. One visit is booked for the scheduled start
// as a backup; a moved start or new link replaces it. As soon as someone is in a meeting (liveSince is when it
// began) that no recorder has visited, one is sent right away and a booking still more than a minute off is
// replaced. That also covers a meeting that ends and is joined again, without re-sending to a meeting that
// turned the recorder away or that Google has not marked ended yet.
export function planRecorder(
  session: Pick<Interview, "starts_at" | "ends_at"> & { wanted: boolean },
  visits: Visit[], meetUrl: string | null, liveSince: string | null, now = Date.now(),
): RecorderPlan {
  const booked = visits.filter(v => v.state === "scheduled");
  if (!session.wanted || !meetUrl) return { cancel: booked.map(v => v.name), create: null };
  const start = Date.parse(session.starts_at);
  const current = booked.find(v => v.meet_url === meetUrl && v.planned_start && Date.parse(v.planned_start) === start);
  const cancel = booked.filter(v => v !== current).map(v => v.name);
  const kept = visits.filter(v => v.state !== "cancelled" && !cancel.includes(v.name));
  const create = { join_at: null as string | null, planned_start: session.starts_at };
  if (start > now && !kept.some(v => v.planned_start && Date.parse(v.planned_start) === start)) {
    // Someone already in the meeting gets the recorder now rather than at the start.
    const join_at = liveSince && recorderWindowOpen(session, now) ? null : recorderJoinAt(session.starts_at, now);
    if (join_at || recorderWindowOpen(session, now)) return { cancel, create: { ...create, join_at } };
  }
  if (!liveSince || !recorderWindowOpen(session, now)) return { cancel, create: null };
  if (current) {
    const arriving = !current.join_at || Date.parse(current.join_at) - now <= 60000;
    return arriving ? { cancel, create: null } : { cancel: [...cancel, current.name], create };
  }
  const since = Date.parse(liveSince);
  const visited = kept.some(v => recorderInCall(v.state) || Date.parse(v.created_at) >= since || (v.status_at && Date.parse(v.status_at) >= since));
  // The cap stops a meeting that keeps ending and restarting from drawing a recorder every few minutes.
  return { cancel, create: visited || kept.length >= maxVisits ? null : create };
}

export function recordingStatus(r: Pick<Recording, "state" | "join_at" | "storage_key" | "storage_error">) {
  if (r.storage_key) return "Saved for your team";
  switch (r.state) {
    case "scheduled": return r.join_at ? "Recorder booked" : "Recorder on the way";
    case "joining": return "Recorder joining";
    case "waiting": return "Recorder waiting to be let in";
    case "recording": return "Recording now";
    case "processing": return "Processing";
    case "done": return r.storage_error ? "Saving failed" : "Saving to HireFlow";
    case "failed": return "Not recorded";
    default: return "Cancelled";
  }
}

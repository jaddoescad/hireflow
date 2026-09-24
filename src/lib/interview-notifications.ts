import "server-only";
import { adminDb } from "./supabase/server";
import { sendInterviewNotification } from "./mail";
import type { InterviewNotification } from "./interviews";

export async function notifyInterviewOrganizer(company: string, generation: string, worker: string, id: string, version: number) {
  const db = adminDb();
  const args = { cid: company, generation_id: generation, worker, sid: id, revision: version };
  // The database rechecks the lease, current revision and enabled members before exposing the email payload.
  const prepared = await db.rpc("hf_interview_notification", args);
  if (prepared.error) throw new Error("Could not prepare organizer confirmation.");
  if (!prepared.data) return;
  let outcome: { sent: true } | { error: string };
  try {
    await sendInterviewNotification(prepared.data as InterviewNotification);
    outcome = { sent: true };
  } catch {
    outcome = { error: "Organizer confirmation email could not be sent. HireFlow will retry automatically." };
  }
  const saved = await db.rpc("hf_interview_notification", { ...args, outcome });
  if (saved.error) throw new Error("Could not save organizer confirmation status.");
}

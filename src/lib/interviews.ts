import { z } from "zod";

export const interviewSchema = z.object({
  id: z.uuid(), version: z.number().int().nonnegative().default(0),
  candidate_id: z.uuid(), title: z.string().trim().min(1).max(160),
  starts_at: z.iso.datetime(), ends_at: z.iso.datetime(),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Choose a valid timezone."),
  interviewer_ids: z.array(z.uuid()).min(1).max(30),
  auto_record: z.boolean(),
  // Saved on the candidate record so invitations and email matching use the corrected address.
  candidate_email: z.string().trim().toLowerCase().email("Enter a valid candidate email.").max(254),
}).refine(value => {
  const duration = Date.parse(value.ends_at) - Date.parse(value.starts_at);
  return duration > 0 && duration <= 12 * 60 * 60 * 1000;
}, "Interviews must last between 1 minute and 12 hours.");

export type Interview = {
  id: string; company_id: string; candidate_id: string; title: string;
  starts_at: string; ends_at: string; timezone: string; interviewer_ids: string[];
  attendees: { email: string; responseStatus?: string }[]; organizer: string;
  auto_record: boolean; recording_setup: "pending" | "on" | "off" | "failed"; recording_error: string | null;
  status: "pending" | "scheduled" | "cancelled"; cancel_requested: boolean;
  version: number; synced_version: number; google_event_id: string;
  meet_url: string | null; meet_space: string | null;
  meeting_started_at: string | null; meeting_ended_at: string | null;
  last_error: string | null; synced_at: string | null; updated_by: string | null;
  organizer_notified_version: number; organizer_notification_error: string | null;
};
export function interviewCalendarTitle(title: string, candidate: string) {
  const name = candidate.trim();
  const label = title.trim();
  return !name || label.toLocaleLowerCase() === name.toLocaleLowerCase() ||
    label.toLocaleLowerCase().endsWith(` — ${name.toLocaleLowerCase()}`)
    ? label : `${label} — ${name}`;
}
export function interviewTitleFromCalendar(title: string, candidate: string) {
  const suffix = ` — ${candidate.trim()}`;
  const base = title.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()) ? title.slice(0, -suffix.length) : title;
  return (base.trim() || title).slice(0, 160);
}
export type InterviewNotification = Pick<Interview,
  "id" | "company_id" | "version" | "title" | "organizer" | "starts_at" | "ends_at" | "timezone" | "status" | "meet_url" | "organizer_notified_version"
> & { candidate_name: string };
export function interviewNotificationMessage(session: InterviewNotification) {
  const title = interviewCalendarTitle(session.title, session.candidate_name);
  const action = session.status === "cancelled" ? "cancelled" : session.organizer_notified_version ? "updated" : "scheduled";
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: session.timezone, weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  return {
    subject: `Interview ${action}: ${title}`,
    text: [
      `Your interview has been ${action}.`, "", title,
      `Candidate: ${session.candidate_name}`,
      `Starts: ${format.format(new Date(session.starts_at))}`,
      `Ends: ${format.format(new Date(session.ends_at))}`,
      `Time zone: ${session.timezone}`, "",
      ...(session.status !== "cancelled" && session.meet_url ? [`Join Google Meet: ${session.meet_url}`, ""] : []),
      "This is your organizer confirmation from HireFlow. Google Calendar handles guest invitations and updates separately.",
    ].join("\n"),
  };
}
export type Recording = {
  interview_id: string; name: string; conference: string; state: string; starts_at: string | null;
  ends_at: string | null; drive_file_id: string | null; playback_url: string | null;
  storage_key: string | null; storage_error: string | null;
};
export type GoogleConnection = {
  connected: boolean; available: boolean; account: string | null;
  synced_at: string | null; last_error: string | null;
  instant_updates: boolean; events_error: string | null;
};
export function googleMeetUrl(value: string | undefined | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "meet.google.com" &&
      /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname) ? url.origin + url.pathname : null;
  } catch { return null; }
}
// Prefer Google's own playback link; fall back to the Drive viewer for the file.
export function recordingUrl(exportUri: string | undefined, fileId: string | undefined) {
  try {
    const url = new URL(exportUri || "");
    if (url.protocol === "https:" && url.hostname === "drive.google.com") return url.toString();
  } catch { /* use the file ID */ }
  return fileId && /^[a-zA-Z0-9_-]+$/.test(fileId)
    ? `https://drive.google.com/file/d/${fileId}/view` : null;
}
// Drive's embeddable player; it plays only for Google accounts that can open the file.
export function recordingPreviewUrl(fileId: string | null | undefined) {
  return fileId && /^[a-zA-Z0-9_-]+$/.test(fileId) ? `https://drive.google.com/file/d/${fileId}/preview` : null;
}
// Drive's thumbnail image; like the player, it loads only for Google accounts that can open the file.
export function recordingThumbnailUrl(fileId: string | null | undefined) {
  return fileId && /^[a-zA-Z0-9_-]+$/.test(fileId) ? `https://lh3.googleusercontent.com/d/${fileId}=w640` : null;
}
// Joins in the 15 minutes before the start still belong to the interview.
export function meetingWindowOpen(session: Pick<Interview, "starts_at">, now = Date.now()) {
  return Date.parse(session.starts_at) - 15 * 60000 <= now;
}
export function localDateTime(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}T${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
}
export function parseLocalDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date.toISOString()) !== value)
    throw new Error("This local time does not exist. Choose another time.");
  return date.toISOString();
}
export const interviewLengths = [15, 30, 45, 60, 90];
export function localInterviewWindow(day: string, startTime: string, minutes: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(startTime) || !(minutes > 0))
    throw new Error("Choose a date, start time and length.");
  const starts_at = parseLocalDateTime(`${day}T${startTime}`);
  return { starts_at, ends_at: new Date(Date.parse(starts_at) + minutes * 60000).toISOString() };
}

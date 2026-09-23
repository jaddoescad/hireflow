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
};
export type Recording = {
  interview_id: string; name: string; conference: string; state: string; starts_at: string | null;
  ends_at: string | null; drive_file_id: string | null; playback_url: string | null;
};
export type MeetConnection = {
  connected: boolean; available: boolean; organizer: string | null;
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

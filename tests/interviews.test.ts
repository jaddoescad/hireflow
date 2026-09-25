import test from "node:test";
import assert from "node:assert/strict";
import { googleMeetUrl, interviewCalendarTitle, interviewNotificationMessage, interviewTitleFromCalendar, interviewSchema, localDateTime, localInterviewWindow, meetingWindowOpen, recordingPreviewUrl, recordingThumbnailUrl, recordingUrl, type InterviewNotification } from "../src/lib/interviews";
test("calendar titles include candidate names without accumulating suffixes", () => {
  assert.equal(interviewCalendarTitle("Interview", "Alex Example"), "Interview — Alex Example");
  assert.equal(interviewCalendarTitle("Interview — Alex Example", "alex example"), "Interview — Alex Example");
  assert.equal(interviewCalendarTitle("Alex Example", "Alex Example"), "Alex Example");
  assert.equal(interviewTitleFromCalendar("Technical round — Alex Example", "Alex Example"), "Technical round");
  assert.equal(interviewTitleFromCalendar("Custom calendar title", "Alex Example"), "Custom calendar title");
  assert.equal(interviewTitleFromCalendar("Interview — A. (Example)", "A. (Example)"), "Interview");
  assert.equal(interviewTitleFromCalendar("X".repeat(200), "Alex"), "X".repeat(160));
});
test("organizer confirmations distinguish scheduling, updates and cancellation with explicit time zones", () => {
  const session: InterviewNotification = {
    id: crypto.randomUUID(), company_id: crypto.randomUUID(), version: 1, title: "Interview", candidate_name: "Alex Example",
    organizer: "organizer@example.com", starts_at: "2026-09-25T03:45:00Z", ends_at: "2026-09-25T04:15:00Z",
    timezone: "America/Toronto", status: "scheduled", meet_url: "https://meet.google.com/abc-defg-hij", organizer_notified_version: 0,
  };
  const scheduled = interviewNotificationMessage(session);
  assert.equal(scheduled.subject, "Interview scheduled: Interview — Alex Example");
  assert.match(scheduled.text, /Sep 24, 2026/);
  assert.match(scheduled.text, /Sep 25, 2026/);
  assert.match(scheduled.text, /Time zone: America\/Toronto/);
  assert.match(scheduled.text, /Join Google Meet: https:\/\/meet.google.com\/abc-defg-hij/);
  assert.match(interviewNotificationMessage({ ...session, organizer_notified_version: 1, version: 2 }).subject, /^Interview updated:/);
  const cancelled = interviewNotificationMessage({ ...session, status: "cancelled" });
  assert.match(cancelled.subject, /^Interview cancelled:/);
  assert.doesNotMatch(cancelled.text, /Join Google Meet/);
});
test("only canonical Google Meet links are accepted", () => {
  assert.equal(googleMeetUrl("https://meet.google.com/abc-defg-hij?authuser=0"), "https://meet.google.com/abc-defg-hij");
  assert.equal(googleMeetUrl("http://meet.google.com/abc-defg-hij"), null);
  assert.equal(googleMeetUrl("https://meet.google.com.example.com/abc-defg-hij"), null);
  assert.equal(googleMeetUrl("https://meet.google.com/lookup/abc"), null);
});
test("recording playback prefers Google's export link and rejects other hosts", () => {
  assert.equal(recordingUrl("https://drive.google.com/file/d/file_1/view", "file_1"), "https://drive.google.com/file/d/file_1/view");
  assert.equal(recordingUrl("https://evil.example.com/file", "file_1"), "https://drive.google.com/file/d/file_1/view");
  assert.equal(recordingUrl(undefined, "bad/id"), null);
  assert.equal(recordingUrl(undefined, undefined), null);
  assert.equal(recordingPreviewUrl("file_1"), "https://drive.google.com/file/d/file_1/preview");
  assert.equal(recordingPreviewUrl("../bad"), null);
  assert.equal(recordingThumbnailUrl("file_1"), "https://lh3.googleusercontent.com/d/file_1=w640");
  assert.equal(recordingThumbnailUrl("bad/id"), null);
});
test("meeting facts are checked from 15 minutes before the start", () => {
  const starts_at = "2026-09-22T15:00:00.000Z";
  assert.equal(meetingWindowOpen({ starts_at }, Date.parse("2026-09-22T14:44:00.000Z")), false);
  assert.equal(meetingWindowOpen({ starts_at }, Date.parse("2026-09-22T14:46:00.000Z")), true);
});
test("interviews need a bounded duration, an interviewer and a candidate email", () => {
  const base = { id: crypto.randomUUID(), candidate_id: crypto.randomUUID(), title: "Interview", timezone: "America/Toronto",
    starts_at: "2026-09-22T15:00:00.000Z", ends_at: "2026-09-22T15:30:00.000Z", interviewer_ids: [crypto.randomUUID()], auto_record: true, candidate_email: " Alex@Example.com " };
  assert.equal(interviewSchema.parse(base).version, 0);
  assert.equal(interviewSchema.parse(base).candidate_email, "alex@example.com");
  assert.throws(() => interviewSchema.parse({ ...base, candidate_email: "not-an-email" }));
  assert.throws(() => interviewSchema.parse({ ...base, ends_at: base.starts_at }));
  assert.throws(() => interviewSchema.parse({ ...base, ends_at: "2026-09-23T04:00:00.000Z" }));
  assert.throws(() => interviewSchema.parse({ ...base, interviewer_ids: [] }));
  assert.throws(() => interviewSchema.parse({ ...base, timezone: "Mars/Base" }));
});
test("interview end times come from the start and length", () => {
  const sameDay = localInterviewWindow("2026-09-22", "09:00", 45);
  assert.equal(Date.parse(sameDay.ends_at) - Date.parse(sameDay.starts_at), 45 * 60000);
  const overnight = localInterviewWindow("2026-09-22", "23:30", 45);
  assert.equal(localDateTime(overnight.ends_at), "2026-09-23T00:15");
  assert.throws(() => localInterviewWindow("2026-09-22", "09:00", 0));
  assert.throws(() => localInterviewWindow("2026-09-22", "", 30));
});

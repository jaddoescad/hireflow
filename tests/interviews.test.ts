import test from "node:test";
import assert from "node:assert/strict";
import { googleMeetUrl, interviewSchema, localDateTime, localInterviewWindow, meetingWindowOpen, recordingUrl } from "../src/lib/interviews";
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
});
test("meeting facts are checked from 15 minutes before the start", () => {
  const starts_at = "2026-09-22T15:00:00.000Z";
  assert.equal(meetingWindowOpen({ starts_at }, Date.parse("2026-09-22T14:44:00.000Z")), false);
  assert.equal(meetingWindowOpen({ starts_at }, Date.parse("2026-09-22T14:46:00.000Z")), true);
});
test("interviews need a bounded duration and at least one interviewer", () => {
  const base = { id: crypto.randomUUID(), candidate_id: crypto.randomUUID(), title: "Interview", timezone: "America/Toronto",
    starts_at: "2026-09-22T15:00:00.000Z", ends_at: "2026-09-22T15:30:00.000Z", interviewer_ids: [crypto.randomUUID()], auto_record: true };
  assert.equal(interviewSchema.parse(base).version, 0);
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

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { planRecorder, recallState, recorderJoinAt, recorderProblem, recorderWindowOpen, recordingStatus } from "../src/lib/recorder";
import { verifyRecallSignature } from "../src/lib/crypto";

const link = "https://meet.google.com/abc-defg-hij";
const now = Date.parse("2026-09-29T14:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
const session = (start: number, wanted = true) => ({ starts_at: at(start), ends_at: at(start + 45), wanted });
type Visit = Parameters<typeof planRecorder>[1][number];
const visit = (v: Partial<Visit>): Visit => ({ name: "bot-1", state: "scheduled", planned_start: at(60), join_at: at(59), meet_url: link,
  created_at: at(-1440), status_at: null, ...v });

test("recorders are booked a minute early, or sent now when the start is too close to book", () => {
  assert.equal(recorderJoinAt(at(60), now), at(59));
  assert.equal(recorderJoinAt(at(12.5), now), at(11.5));
  assert.equal(recorderJoinAt(at(12), now), null);
  assert.equal(recorderWindowOpen(session(16), now), false);
  assert.equal(recorderWindowOpen(session(14), now), true);
  assert.equal(recorderWindowOpen(session(-164), now), true);
  assert.equal(recorderWindowOpen(session(-166), now), false);
});

test("one recorder is booked per scheduled start and replaced when the time or link changes", () => {
  assert.deepEqual(planRecorder(session(60), [], link, null, now), { cancel: [], create: { join_at: at(59), planned_start: at(60) } });
  assert.deepEqual(planRecorder(session(60), [visit({})], link, null, now), { cancel: [], create: null });
  assert.deepEqual(planRecorder(session(90), [visit({})], link, null, now), { cancel: ["bot-1"], create: { join_at: at(89), planned_start: at(90) } });
  assert.deepEqual(planRecorder(session(60), [visit({ meet_url: "https://meet.google.com/xyz-abcd-efg" })], link, null, now),
    { cancel: ["bot-1"], create: { join_at: at(59), planned_start: at(60) } });
  // Close to the start, a recorder is sent right away.
  assert.deepEqual(planRecorder(session(5), [], link, null, now), { cancel: [], create: { join_at: null, planned_start: at(5) } });
  // A visit that already happened for this start is not repeated before the start.
  assert.deepEqual(planRecorder(session(5), [visit({ state: "failed", planned_start: at(5) })], link, null, now), { cancel: [], create: null });
});

test("turning recording off, cancelling or losing the link cancels only booked recorders", () => {
  const visits = [visit({}), visit({ name: "bot-2", state: "recording" })];
  assert.deepEqual(planRecorder(session(60, false), visits, link, null, now), { cancel: ["bot-1"], create: null });
  assert.deepEqual(planRecorder(session(60), visits, null, null, now), { cancel: ["bot-1"], create: null });
});

test("a recorder is sent to a meeting it has not visited, including one joined again after it left", () => {
  const ended = visit({ state: "done", planned_start: at(-30), join_at: at(-31), status_at: at(-10) });
  // The meeting that began after the recorder's last update is a rejoin.
  assert.deepEqual(planRecorder(session(-30), [ended], link, at(-5), now), { cancel: [], create: { join_at: null, planned_start: at(-30) } });
  // A meeting it already visited, or one Google has not marked ended after it left, gets no second recorder.
  assert.deepEqual(planRecorder(session(-30), [ended], link, at(-31), now), { cancel: [], create: null });
  assert.deepEqual(planRecorder(session(-30), [visit({ state: "failed", planned_start: at(-30), status_at: at(-20) })], link, at(-25), now), { cancel: [], create: null });
  assert.deepEqual(planRecorder(session(-30), [ended], link, null, now), { cancel: [], create: null });
  assert.deepEqual(planRecorder(session(-30), [ended, visit({ name: "bot-2", state: "waiting", status_at: at(-30) })], link, at(-5), now), { cancel: [], create: null });
  const failures = ["a", "b", "c", "d", "e"].map(name => visit({ name, state: "failed", planned_start: at(-30), status_at: at(-20) }));
  assert.equal(planRecorder(session(-30), failures.slice(1), link, at(-5), now).create?.join_at, null);
  assert.deepEqual(planRecorder(session(-30), failures, link, at(-5), now), { cancel: [], create: null });
  // Past the window nothing new is sent.
  assert.deepEqual(planRecorder(session(-170), [ended], link, at(-5), now), { cancel: [], create: null });
  // People joining before the start leave the booked recorder to arrive on time.
  assert.deepEqual(planRecorder(session(14), [visit({ planned_start: at(14), join_at: at(13) })], link, at(-1), now), { cancel: [], create: null });
  assert.deepEqual(planRecorder(session(0.5), [visit({ planned_start: at(0.5), join_at: at(-0.5) })], link, at(-5), now), { cancel: [], create: null });
});

test("Recall statuses map to recording states and team-facing reasons", () => {
  assert.equal(recallState("in_waiting_room"), "waiting");
  assert.equal(recallState("in_call_recording"), "recording");
  assert.equal(recallState("done"), "done");
  assert.equal(recallState("fatal"), "failed");
  assert.equal(recallState("analysis_done"), null);
  assert.equal(recallState("toString"), null);
  assert.match(recorderProblem("call_ended", "timeout_exceeded_waiting_room")!, /Nobody let/);
  assert.equal(recorderProblem("call_ended", "timeout_exceeded_everyone_left"), null);
  assert.match(recorderProblem("fatal", "something_new")!, /could not record/);
  assert.equal(recordingStatus({ state: "waiting", join_at: null, storage_key: null, storage_error: null }), "Recorder waiting to be let in");
  assert.equal(recordingStatus({ state: "done", join_at: null, storage_key: "k", storage_error: null }), "Saved for your team");
});

test("Recall webhook signatures are checked against the secret, time and body", () => {
  const secret = "whsec_" + Buffer.from("synthetic-secret").toString("base64");
  const body = JSON.stringify({ event: "bot.done" });
  const timestamp = String(Math.floor(now / 1000));
  const sign = (text: string) => createHmac("sha256", Buffer.from("synthetic-secret")).update(`msg_1.${timestamp}.${text}`).digest("base64");
  const headers = { id: "msg_1", timestamp, signature: `v1,bad v1,${sign(body)}` };
  assert.equal(verifyRecallSignature(body, headers, secret, now), true);
  assert.equal(verifyRecallSignature(body + " ", headers, secret, now), false);
  assert.equal(verifyRecallSignature(body, headers, secret, now + 400000), false);
  assert.equal(verifyRecallSignature(body, { ...headers, signature: `v2,${sign(body)}` }, secret, now), false);
  assert.equal(verifyRecallSignature(body, headers, "not-a-whsec", now), false);
});

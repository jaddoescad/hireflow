import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSummary } from "../src/lib/score-summary";

test("chat summary excludes unassessed ratings from average and keeps notes and custom categories", () => {
  const text = scoreSummary({ name: "Sample Candidate", job_title: "Painter" }, [
    { name: "Communication", rating: 4, note: "Clear answers\nwith examples" },
    { name: "Rapport", rating: null, note: "Follow up" },
  ], true);
  assert.match(text, /Overall: 4.0\/10 \(1\/2 assessed\)/);
  assert.match(text, /includes unsaved changes/);
  assert.match(text, /Communication: 4\/10 — Clear answers with examples/);
  assert.match(text, /Rapport: Not assessed — Follow up/);
});

test("empty scorecard has no invented rating", () => {
  const text = scoreSummary({ name: "Sample", job_title: "" }, [], false);
  assert.match(text, /Overall: Not assessed \(0\/0 assessed\)/);
  assert.doesNotMatch(text, /NaN|unsaved|undefined/);
});

test("zero counts as assessed and uses the ten-point denominator", () => {
  const text = scoreSummary({ name: "Sample", job_title: "" }, [
    { name: "Communication", rating: 0, note: "" },
    { name: "Experience", rating: 10, note: "" },
    { name: "Rapport", rating: null, note: "" },
  ], false);
  assert.match(text, /Overall: 5.0\/10 \(2\/3 assessed\)/);
  assert.match(text, /Communication: 0\/10/);
});

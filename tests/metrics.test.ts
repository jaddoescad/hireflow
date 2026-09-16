import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarDay,
  candidateDay,
  EMPTY_FILTERS,
  filterCandidates,
  uniqueContacts,
  volumeSeries,
  stageBreakdown,
} from "../src/lib/metrics";
import type { Candidate, Stage } from "../src/lib/types";
const row = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: "a",
  company_id: "one",
  stage_id: "applied",
  name: "Synthetic applicant",
  email: "test@example.com",
  phone: null,
  experience: "3-5 years",
  job_title: "Painter",
  source: "Hiring Sheet",
  attributes: { "Applied at": "2026-06-19 13:15:00", Decision: "Not a fit" },
  tags: [],
  created_at: "2026-09-15T12:00:00Z",
  updated_at: "2026-09-15T12:00:00Z",
  ...overrides,
});
test("metrics use original application dates, validate dates, and do not invent missing import dates", () => {
  assert.equal(candidateDay(row(), "applied"), "2026-06-19");
  assert.equal(candidateDay(row(), "added"), "2026-09-15");
  assert.equal(candidateDay(row({ attributes: {} }), "applied"), null);
  assert.equal(
    candidateDay(row({ source: "Meta", attributes: {} }), "applied"),
    "2026-09-15",
  );
  assert.equal(calendarDay("2026-02-30"), null);
  assert.equal(calendarDay("06/07/2026"), null);
});
test("metrics combine filters inclusively and isolate companies", () => {
  const rows = [
    row(),
    row({ id: "b", company_id: "two" }),
    row({ id: "c", experience: "1-2 years" }),
  ];
  assert.equal(
    filterCandidates(rows, "one", {
      ...EMPTY_FILTERS,
      from: "2026-06-19",
      to: "2026-06-19",
      experience: "3-5 years",
      decision: "Not a fit",
    }).length,
    1,
  );
  assert.equal(
    filterCandidates(rows, "one", { ...EMPTY_FILTERS, from: "2026-06-20" })
      .length,
    0,
  );
  assert.equal(
    filterCandidates(rows, "one", { ...EMPTY_FILTERS, stage: "hired" }).length,
    0,
  );
});
test("contact counts normalize email and fall back to phone or distinct records", () => {
  assert.equal(
    uniqueContacts([
      row(),
      row({ id: "b", email: " TEST@example.com " }),
      row({ id: "c", email: null, phone: "+16135550123" }),
      row({ id: "d", email: null, phone: "+16135550123" }),
      row({ id: "e", email: null }),
    ]),
    3,
  );
});
test("volume fills zero days and chooses bounded weekly/monthly buckets", () => {
  const f = { ...EMPTY_FILTERS, from: "2026-06-18", to: "2026-06-20" };
  assert.deepEqual(
    volumeSeries([row()], f).points.map((p) => p.count),
    [0, 1, 0],
  );
  assert.equal(
    volumeSeries([row()], { ...f, from: "2026-01-01" }).unit,
    "week",
  );
  assert.equal(
    volumeSeries([row()], { ...f, from: "2025-01-01" }).unit,
    "month",
  );
  assert.deepEqual(volumeSeries([], EMPTY_FILTERS).points, []);
});
test("stage counts include empty stages without inferring historical conversion", () => {
  const stages = [
    { id: "applied", company_id: "one", name: "Applied", position: 0 },
    { id: "saved", company_id: "one", name: "Saved for later", position: 1 },
    { id: "other", company_id: "two", name: "Other", position: 0 },
  ] as Stage[];
  assert.deepEqual(
    stageBreakdown([row()], stages, "one").map((s) => [s.name, s.count]),
    [
      ["Applied", 1],
      ["Saved for later", 0],
    ],
  );
});

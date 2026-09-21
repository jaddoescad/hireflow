import { test } from "node:test";
import assert from "node:assert/strict";
import { actions } from "../src/lib/validation";

const candidate_id = "11111111-1111-4111-8111-111111111111";
const category_id = "22222222-2222-4222-8222-222222222222";
const score = {
  category_id,
  rating: 4,
  note: "Clear examples",
  expected_version: null,
};

test("ten-point scores accept both endpoints and reject stale five-point clients", () => {
  for (const rating of [0, 1, 7, 10, null]) {
    assert.equal(actions.scores_save.safeParse({ rating_scale: 10, candidate_id, scores: [{ ...score, rating }] }).success, true);
  }
  assert.equal(actions.scores_save.safeParse({ candidate_id, scores: [score] }).success, false);
  assert.equal(actions.scores_save.safeParse({ rating_scale: 5, candidate_id, scores: [score] }).success, false);
});

test("scorecards accept partial ratings, explicit unassessed values, and conflict versions", () => {
  assert.deepEqual(
    actions.scores_save.parse({ rating_scale: 10, candidate_id, scores: [score] }).scores,
    [score],
  );
  const cleared = actions.scores_save.parse({
    rating_scale: 10,
    candidate_id,
    scores: [{ ...score, rating: null, note: "", expected_version: 2 }],
  });
  assert.equal(cleared.scores[0].rating, null);
  assert.equal(cleared.scores[0].expected_version, 2);
});

test("scorecards reject invalid ratings, duplicate categories, missing versions, and oversized notes", () => {
  for (const rating of [-1, 11, 2.5, "4", undefined]) {
    assert.equal(
      actions.scores_save.safeParse({
        rating_scale: 10,
    candidate_id,
        scores: [{ ...score, rating }],
      }).success,
      false,
    );
  }
  for (const scores of [
    [],
    [score, score],
    [{ ...score, expected_version: undefined }],
    [{ ...score, expected_version: 0 }],
    [{ ...score, note: "x".repeat(2001) }],
  ]) {
    assert.equal(
      actions.scores_save.safeParse({ candidate_id, scores }).success,
      false,
    );
  }
});

test("category names are required and normalized for all-position scorecards", () => {
  assert.deepEqual(
    actions.score_category_save.parse({
      name: " Communication ",
      description: " Clarity ",
    }),
    {
      name: "Communication",
      description: "Clarity",
    },
  );
  for (const name of [" ", "x".repeat(81)]) {
    assert.equal(
      actions.score_category_save.safeParse({ name }).success,
      false,
    );
  }
});

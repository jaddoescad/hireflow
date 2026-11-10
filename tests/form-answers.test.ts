import { test } from "node:test";
import assert from "node:assert/strict";
import { intakeSchema } from "../src/lib/validation";
import { parseFormAnswers } from "../src/lib/form-answers";

test("complete Zapier output preserves new questions, choices, empty and long answers", () => {
  const written = "First line\n" + "Detailed answer. ".repeat(200);
  const response = {
    id: "synthetic-lead",
    company_id: "untrusted-company",
    raw: {
      a_brand_new_question_never_mapped_before: ["weekday_daytime", "weekends"],
      "describe_your_plan?": written,
      optional_answer: [],
    },
    a_brand_new_question_never_mapped_before: ["Weekday daytime", "Weekends"],
  };
  const candidate = intakeSchema.parse({
    source_id: "synthetic-lead", name: "Alex Example", email: "alex@example.com",
    form_response: JSON.stringify(response), attributes: { Form: "Synthetic form" },
  });
  assert.deepEqual(candidate.attributes["Form answers"], [
    { question: "A brand new question never mapped before", answer: "Weekday daytime, Weekends" },
    { question: "Describe your plan?", answer: written },
    { question: "Optional answer", answer: "" },
  ]);
  assert.equal(candidate.attributes.Form, "Synthetic form");
  assert.equal("company_id" in candidate, false);
  assert.equal("form_response" in candidate, false);
});

test("Meta field_data and flattened Zapier raw fields retain all submitted answers", () => {
  assert.deepEqual(parseFormAnswers({ field_data: [
    { name: "new_question?", values: ["A", "B"] },
  ] }), [{ question: "New question?", answer: "A, B" }]);
  assert.deepEqual(parseFormAnswers({ raw__new_question: "yes", new_question: "Yes", ad_id: "ignore" }),
    [{ question: "New question", answer: "Yes" }]);
  assert.deepEqual(parseFormAnswers('base64:' + Buffer.from('{"raw":{"new_question":"Réponse"}}').toString('base64')),
    [{ question: "New question", answer: "Réponse" }]);
});

test("a replaced project-management question is captured with its full wording without a new mapping", () => {
  const question = "Describe your project management experience, including the types of projects you have managed and your responsibilities.";
  const key = question.toLowerCase().replaceAll(" ", "_");
  const response = { raw: { [key]: "Managed renovation schedules, budgets, and subcontractors." } };
  const result = intakeSchema.parse({ source_id: "synthetic-updated-form", name: "Alex Example",
    email: "alex@example.com", form_response: "base64:" + Buffer.from(JSON.stringify(response)).toString("base64") });
  assert.deepEqual(result.attributes["Form answers"], [{ question,
    answer: "Managed renovation schedules, budgets, and subcontractors." }]);
  assert.equal(JSON.stringify(result.attributes).includes("quality issue"), false);
});

test("malformed complete responses fail rather than silently losing their answers", () => {
  for (const response of ["not JSON", {}, { raw: { question: { unexpected: true } } },
    { raw: { question: "x".repeat(20001) } }]) {
    assert.equal(intakeSchema.safeParse({ source_id: "synthetic", name: "Alex",
      email: "alex@example.com", form_response: response }).success, false);
  }
  assert.deepEqual(parseFormAnswers(undefined), []);
});

test("Meta form applications cannot silently succeed without their complete response", () => {
  const application = { source_id: "synthetic-missing-response", name: "Alex Example",
    email: "alex@example.com", attributes: { Form: "Synthetic hiring form" } };
  assert.equal(intakeSchema.safeParse(application).success, false);
  assert.equal(intakeSchema.safeParse({ ...application, source: "Hiring Sheet" }).success, true);
});

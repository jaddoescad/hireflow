export type FormAnswer = { question: string; answer: string };

const choiceLabels: Record<string, string> = {
  weekday_daytime: "Weekday daytime", weekday_evenings: "Weekday evenings",
  flexible_schedule: "Flexible schedule", weekends: "Weekends",
  yes: "Yes", no: "No", immediately: "Immediately",
  within_1_week: "Within 1 week", within_2_weeks: "Within 2 weeks",
  "within_3–4_weeks": "Within 3–4 weeks", more_than_4_weeks_from_now: "More than 4 weeks from now",
  less_than_1_year: "Less than 1 year", "1–2_years": "1–2 years",
  "3–5_years": "3–5 years", "6–10_years": "6–10 years", more_than_10_years: "More than 10 years",
  less_than_1: "Less than 1 year", "1_to_2": "1–2 years", "3_to_5": "3–5 years", "5_plus": "5+ years",
  crew_leader: "Crew Leader", helper: "Helper", professional_painter: "Professional Painter",
  project_manager: "Project Manager", "subcontractor_(multiple_crews)": "Subcontractor (multiple crews)",
  "1_to_2_weeks": "1–2 weeks", "3_plus_weeks": "3+ weeks",
  "25_to_30": "$25–$30", "30_to_35": "$30–$35", "35_to_40": "$35–$40",
};

/** Decode known choice fields only; applicants' written answers stay verbatim. */
export function formatFormAnswer(question: string, answer: string): string {
  const key = question.toLowerCase().replaceAll("_", " ");
  if (!/^(what is your availability|how many years of professional painting experience|can you reliably travel|when could you start|painting experience$|best fit position$|crew lead experience$|transportation$|start availability$|hourly pay expectation$)/.test(key))
    return answer;
  return answer.split(/[|,]/).map((choice) => choiceLabels[choice.trim()] ?? choice.trim()).join(", ");
}

/** Read the complete Meta/Zapier response, without a per-form field allowlist. */
export function parseFormAnswers(input: unknown): FormAnswer[] {
  if (input === undefined) return [];
  // Encoded text prevents automation tools from expanding JSON into mapped fields.
  if (typeof input === "string" && input.startsWith("base64:"))
    input = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(input.slice(7)), (char) => char.charCodeAt(0)),
    );
  const response = typeof input === "string" ? JSON.parse(input) : input;
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw new Error("Form response must be a JSON object.");
  const data = response as Record<string, unknown>;
  let entries: [string, unknown][];
  if (Array.isArray(data.field_data)) {
    entries = data.field_data.map((field) => {
      if (!field || typeof field.name !== "string" || !Array.isArray(field.values))
        throw new Error("Invalid form answer.");
      return [field.name, field.values];
    });
  } else if (data.raw && typeof data.raw === "object" && !Array.isArray(data.raw)) {
    entries = Object.entries(data.raw);
  } else {
    entries = Object.entries(data)
      .filter(([key]) => key.startsWith("raw__"))
      .map(([key, value]) => [key.slice(5), value]);
  }
  if (!entries.length || entries.length > 200)
    throw new Error("Form response must contain between 1 and 200 answers.");
  return entries.map(([key, raw]) => {
    if (!key.trim() || key.length > 1000)
      throw new Error("Invalid form question.");
    // Zapier supplies readable choice labels alongside the raw form fields.
    const value = Object.hasOwn(data, key) ? data[key] : raw;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => v !== null && !["string", "number", "boolean"].includes(typeof v)))
      throw new Error("Invalid form answer.");
    const answer = values.map((v) => String(v ?? "")).join(", ");
    if (answer.length > 20000) throw new Error("Form answer is too long.");
    const question = key.replaceAll("_", " ").replace(/\s+/g, " ").trim();
    return { question: question.charAt(0).toUpperCase() + question.slice(1),
      answer: formatFormAnswer(question, answer) };
  });
}

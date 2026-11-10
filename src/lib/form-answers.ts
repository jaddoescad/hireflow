export type FormAnswer = { question: string; answer: string };

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
    return { question: question.charAt(0).toUpperCase() + question.slice(1), answer };
  });
}

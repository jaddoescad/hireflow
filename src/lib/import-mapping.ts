import { createHash } from "node:crypto";
import { intakeSchema } from "./validation";
export function mapHiringRow(
  headers: string[],
  row: unknown[],
  sourceFile: string,
  rowNumber: number,
) {
  const fields = Object.fromEntries(
    headers.map((h, i) => [h.trim(), String(row[i] ?? "").trim()]),
  );
  if (!fields["Full Name"]) return null;
  const type = fields["Applicant Type"];
  const tags = [
    type,
    fields["Led Crew Before"] === "Yes" ? "Crew lead experience" : "",
    fields["Transportation Answer"] === "Yes" ? "Own transportation" : "",
  ].filter(Boolean);
  const attributes = Object.fromEntries(
    headers
      .map((h, i) => [h.trim() || "Applied at", String(row[i] ?? "").trim()])
      .filter(
        ([h, v]) =>
          v &&
          ![
            "Full Name",
            "Email",
            "Phone Number",
            "Years Painting Experience",
            "Position Applied For",
            "Applicant Type",
          ].includes(h),
      ),
  );
  // Content identity survives row sorting; the original row remains available for audit.
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        sourceFile,
        row[0],
        fields["Full Name"],
        fields.Email,
        fields["Phone Number"],
      ]),
    )
    .digest("hex");
  return intakeSchema.parse({
    source: "Hiring Sheet",
    source_id: identity,
    name: fields["Full Name"],
    email: fields.Email,
    phone: fields["Phone Number"],
    job_title: fields["Position Applied For"],
    experience: fields["Years Painting Experience"],
    tags,
    attributes: { ...attributes, source_row: rowNumber },
  });
}

import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
export function normalizePhone(value: string) {
  if (!value.trim()) return "";
  const phone = parsePhoneNumberFromString(value, "CA");
  if (!phone?.isValid())
    throw new Error("Enter a valid phone number, including country code.");
  return phone.number;
}
export const email = z.string().trim().toLowerCase().email().max(254);
const id = z.uuid();
const optionalContact = z.string().trim().max(254).default("");
const candidate = {
  id: id.optional(),
  stage_id: id,
  name: z.string().trim().min(1).max(160),
  email: optionalContact.transform((v) => (v ? email.parse(v) : "")),
  phone: z.string().max(40).default("").transform(normalizePhone),
  job_title: z.string().trim().max(100).default(""),
  experience: z.string().trim().max(100).default(""),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
};
export const actions = {
  score_category_save: z.object({
    id: id.optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(""),
  }),
  score_category_remove: z.object({ id }),
  scores_save: z.object({
    rating_scale: z.literal(10, { error: "The rating scale changed. Refresh the page before saving." }),
    candidate_id: id,
    scores: z
      .array(
        z.object({
          category_id: id,
          rating: z.number().int().min(0).max(10).nullable(),
          note: z.string().trim().max(2000).default(""),
          expected_version: z.number().int().min(1).max(2147483647).nullable(),
        }),
      )
      .min(1)
      .max(50)
      .refine(
        (scores) =>
          new Set(scores.map((s) => s.category_id)).size === scores.length,
        "Each category can only appear once.",
      ),
  }),
  quo_sync: z.object({ candidate_id: id }),
  stage_reorder: z.object({ id, direction: z.enum(["up", "down"]) }),
  create_company: z.object({ name: z.string().trim().min(1).max(100) }),
  rename_company: z.object({ name: z.string().trim().min(1).max(100) }),
  candidate_save: z.object(candidate),
  move: z.object({ id, stage_id: id }),
  note: z.object({
    candidate_id: id,
    body: z.string().trim().min(1).max(10000),
  }),
  signal_link: z.object({ id, candidate_id: id }),
  signal_read: z.object({ id }),
  invite: z.object({ email, role: z.enum(["admin", "member"]) }),
  accept_invitation: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }),
  revoke_invitation: z.object({ id }),
  member: z.object({
    user_id: id,
    role: z.enum(["admin", "member"]),
    enabled: z.boolean(),
  }),
  stage_save: z.object({
    id: id.optional(),
    name: z.string().trim().min(1).max(60),
    position: z.number().int().min(0).max(1000),
    color: z.enum(["blue", "slate", "violet", "amber", "green", "red"]),
  }),
  stage_delete: z.object({ id }),
  integration: z.object({
    rotate_intake: z.boolean().optional(),
    quo_api_key: z.string().trim().max(500).optional(),
    quo_phone_id: z.string().trim().max(100).optional(),
    quo_phone: z.string().max(40).transform(normalizePhone).optional(),
    quo_signing_secret: z.string().trim().max(500).optional(),
  }),
};
export const intakeSchema = z
  .object({
    source_id: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(60).default("Meta"),
    name: candidate.name,
    email: candidate.email,
    phone: z.string().max(40).default(""),
    job_title: candidate.job_title,
    experience: candidate.experience,
    tags: candidate.tags,
    attributes: z
      .record(
        z.string().max(100),
        z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
      )
      .default({}),
  })
  .transform((value) => {
    const attributes = { ...value.attributes };
    const tags = new Set(value.tags);
    let phone = "";
    try {
      phone = normalizePhone(value.phone);
    } catch {
      attributes["Original phone (needs review)"] = value.phone;
      tags.add("Phone needs review");
    }
    const type = attributes["Applicant Type"];
    if (typeof type === "string" && type.trim() && type.length <= 60)
      tags.add(type.trim());
    if (attributes["Led Crew Before"] === "Yes")
      tags.add("Crew lead experience");
    if (attributes["Transportation Answer"] === "Yes")
      tags.add("Own transportation");
    return {
      ...value,
      phone,
      attributes,
      tags: candidate.tags.parse([...tags]),
    };
  })
  .refine((v) => v.email || v.phone, {
    message: "An email or phone number is required.",
  });

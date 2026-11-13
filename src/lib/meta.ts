import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { intakeSchema } from "./validation";
import { formatFormAnswer } from "./form-answers";

export const metaId = z.string().regex(/^\d{1,40}$/, "Enter a numeric Meta ID.");
export const metaFormSchema = z.object({
  id: metaId,
  name: z.string().trim().min(1).max(300),
  applicant_type: z.string().trim().min(1).max(60),
  job_title: z.string().trim().max(100).default(""),
  sms: z.string().trim().max(1600).default(""),
});
export type MetaForm = z.infer<typeof metaFormSchema>;
export const metaSettingsSchema = z.object({
  forms: z.array(metaFormSchema).min(1).max(50).refine(
    forms => new Set(forms.map(f => f.id)).size === forms.length, "Select each form once."),
  notification_email: z.union([z.literal(""), z.email().max(254)]),
  sender_name: z.string().trim().min(1).max(100),
});
export type MetaSettings = z.infer<typeof metaSettingsSchema>;
export type MetaCredentials = { app_secret: string; page_token: string; verify_token: string };
export const metaLeadSchema = z.object({
  id: metaId, form_id: metaId, created_time: z.string().min(1).max(100),
  ad_id: metaId.optional(),
  field_data: z.array(z.object({ name: z.string().min(1).max(1000), values: z.array(z.string().max(20000)).max(100) })).min(1).max(200),
  custom_disclaimer_responses: z.array(z.object({
    checkbox_key: z.string().min(1).max(900),
    is_checked: z.union([z.literal("1"), z.literal(""), z.literal("0"), z.boolean(), z.literal(0), z.literal(1)]),
  })).max(100).optional(),
});
export type MetaLead = z.infer<typeof metaLeadSchema>;

export function validMetaSignature(raw: string, signature: string | null, secret: string) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const digest = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(digest, Buffer.from(signature.slice(7), "hex"));
}

export function metaEvents(input: unknown) {
  const body = z.object({ object: z.literal("page"), entry: z.array(z.object({
    id: metaId, changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100),
  })).max(100) }).parse(input);
  return body.entry.flatMap(entry => entry.changes.filter(c => c.field === "leadgen").map(c => {
    const value = z.object({ leadgen_id: metaId, form_id: metaId, page_id: metaId }).parse(c.value);
    if (entry.id !== value.page_id) throw new Error("Meta Page does not match the event.");
    return value;
  }));
}

// Field names vary between form versions. Routing is explicit; every answer is retained.
export function metaApplication(input: unknown, form: MetaForm) {
  const lead = metaLeadSchema.parse(input);
  if (lead.form_id !== form.id) throw new Error("Lead does not belong to the selected form.");
  if (!Number.isFinite(Date.parse(lead.created_time))) throw new Error("Invalid application date.");
  const fields = lead.field_data.map(f => ({ key: f.name.replaceAll("_", " ").toLowerCase(), value: f.values.join(", ") }));
  const answer = (pattern: RegExp) => {
    const field = fields.find(f => pattern.test(f.key));
    return field ? formatFormAnswer(field.key, field.value) : "";
  };
  return intakeSchema.parse({
    source: "Meta", source_id: lead.id,
    name: answer(/^full name$/) || [answer(/^first name$/), answer(/^last name$/)].filter(Boolean).join(" "),
    email: answer(/^email$/), phone: answer(/^phone( number)?$/),
    job_title: form.job_title || answer(/^best fit position/),
    experience: answer(/^(painting experience|how many years of professional painting experience)/),
    attributes: {
      "Applicant Type": form.applicant_type, Form: form.name, "Meta form ID": form.id,
      "Applied at": lead.created_time, ...(lead.ad_id ? { "Meta ad ID": lead.ad_id } : {}),
      "Led Crew Before": answer(/^crew lead experience/),
      "Transportation Answer": answer(/^(transportation|can you reliably travel)/),
      "Start Availability": answer(/^(start availability|when could you start)/),
      "Hourly Pay Expectation": answer(/^hourly pay expectation/),
    },
    form_response: { field_data: [...lead.field_data, ...(lead.custom_disclaimer_responses || []).map(response => ({
      name: `Disclaimer checkbox: ${response.checkbox_key}`,
      values: [response.is_checked === "1" || response.is_checked === 1 || response.is_checked === true ? "Checked" : "Not checked"],
    }))] },
  });
}

export function applicationEmail(payload: ReturnType<typeof metaApplication>, settings: Pick<MetaSettings, "sender_name">) {
  const answers = payload.attributes["Form answers"] as { question: string; answer: string }[];
  return {
    subject: "New hiring application from Facebook Lead Ads",
    text: `New hiring application from Facebook Lead Ads\n\nApplicant type: ${payload.attributes["Applicant Type"]}\nForm: ${payload.attributes.Form}\nLead ID: ${payload.source_id}\nSource: Meta Lead Ads\n\nAll application questions and answers:\n${answers.map(a => `${a.question}\n${a.answer || "No answer provided"}`).join("\n\n")}`,
    sender_name: settings.sender_name,
    reply_to: payload.email || undefined,
  };
}

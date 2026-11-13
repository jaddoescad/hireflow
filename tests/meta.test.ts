import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as meta from "../src/lib/meta";

const form: meta.MetaForm = { id: "101", name: "Synthetic hiring form", applicant_type: "Interior", job_title: "", sms: "Thank you for applying. When can we call?" };
const lead: meta.MetaLead = { id: "201", form_id: form.id, created_time: "2026-11-12T20:00:00+0000", field_data: [
  { name: "full_name", values: ["Alex Example"] }, { name: "email", values: ["Alex@EXAMPLE.COM"] },
  { name: "phone_number", values: ["6135550123"] }, { name: "best_fit_position", values: ["crew_leader"] },
  { name: "painting_experience", values: ["3_to_5"] },
  { name: "a_new_question_never_mapped", values: ["A written answer_unchanged", "Second answer"] },
] };
test("direct Meta intake retains all answers, normalizes contacts, and routes only by configured form", () => {
  const result = meta.metaApplication(lead, form);
  assert.equal(result.source_id, lead.id); assert.equal(result.source, "Meta");
  assert.equal(result.email, "alex@example.com"); assert.equal(result.phone, "+16135550123");
  assert.equal(result.job_title, "Crew Leader"); assert.equal(result.experience, "3–5 years");
  assert.equal((result.attributes["Form answers"] as unknown[]).length, lead.field_data.length);
  assert.deepEqual((result.attributes["Form answers"] as unknown[]).at(-1), { question: "A new question never mapped", answer: "A written answer_unchanged, Second answer" });
  assert.equal(meta.metaApplication(lead, { ...form, applicant_type: "Project Manager", job_title: "Project Manager" }).job_title, "Project Manager");
  assert.throws(() => meta.metaApplication({ ...lead, form_id: "999" }, form));
  assert.throws(() => meta.metaApplication({ ...lead, created_time: "invalid" }, form));
  assert.throws(() => meta.metaApplication({ ...lead, field_data: [] }, form));
  assert.throws(() => meta.metaApplication({ ...lead, field_data: lead.field_data.filter(f => !["email", "phone_number"].includes(f.name)) }, form));
  const message = meta.applicationEmail(result, { sender_name: "Example Hiring" });
  assert.match(message.text, /A written answer_unchanged, Second answer/);
  assert.match(message.text, /Crew Leader/); assert.equal(message.reply_to, result.email);
});

function loadModule(path: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => modules[name] || {}, Buffer, URL, Date, AbortSignal, process: { env: {} }, ...globals });
  return exports;
}
const event = (page = "301", id = "201") => ({ object: "page", entry: [{ id: page, changes: [{ field: "leadgen", value: { page_id: page, form_id: "101", leadgen_id: id } }] }] });
test("Meta authenticates raw batches before queueing and returns retryable errors for storage failures", async () => {
  let queued = 0, fails = false;
  const connections = [{ page_id: "301", credentials: "encrypted" }];
  const db = { from: () => ({ select() { return this; }, in() { return this; }, async not() { return { data: connections }; } }),
    async rpc() { queued++; return { data: true, error: fails ? { message: "private database info" } : null }; } };
  const { POST } = loadModule("../src/app/api/webhooks/meta/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/supabase/server": { adminDb: () => db },
    "@/lib/meta": meta, "@/lib/gmail-crypto": { openGmail: () => ({ app_secret: "secret" }) },
    "@/lib/http": { bodyText: (r: Request) => r.text() },
  });
  const send = (input: unknown, secret = "secret", tamper = false) => {
    const raw = JSON.stringify(input);
    return POST(new Request("https://hireflow.example/api/webhooks/meta", { method: "POST", body: raw + (tamper ? " " : ""),
      headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") } }));
  };
  assert.equal((await send(event(), "wrong")).status, 401);
  assert.equal((await send(event(), "secret", true)).status, 401); assert.equal(queued, 0);
  assert.equal((await send(event())).status, 200); assert.equal(queued, 1);
  assert.equal((await send(event("999"))).status, 200); assert.equal(queued, 1, "Unknown Pages never acquire a company mapping");
  assert.equal((await send({ ...event(), entry: [{ id: "999", changes: event().entry[0].changes }] })).status, 400);
  fails = true;
  const response = await send(event()); assert.equal(response.status, 503); assert.equal(await response.text(), "Retry");
});

function worker(options: { email?: string; sms?: string; mailFails?: boolean; quoStatus?: number; quoTimeout?: boolean; leaseDenied?: boolean } = {}) {
  const job: Record<string, any> = { company_id: "company", page_id: "301", lead_id: lead.id, form_id: form.id,
    form, settings: { notification_email: "hiring@example.com", sender_name: "Example Hiring", forms: [form] },
    lease_id: "lease", application: meta.metaApplication(lead, form), email_state: options.email || "pending", sms_state: options.sms || "pending" };
  let claimed = false, emails = 0, texts = 0;
  const db = {
    from(table: string) { return { select() { return this; }, eq() { return this; }, async single() {
      return { data: table === "hf_meta_connections" ? { credentials: "encrypted", active: true, connected_by: "owner" }
        : table === "hf_members" ? { enabled: true, role: "admin" } : { quo_api_key: "key", quo_phone: "+16135550199", quo_phone_id: "PNtest" } };
    } }; },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "hf_meta_claim") { if (claimed) return { data: [] }; claimed = true; return { data: [{ ...job }] }; }
      if (options.leaseDenied && args.operation.endsWith("_start")) return { data: null };
      if (args.operation.endsWith("_start")) job[args.operation.startsWith("email") ? "email_state" : "sms_state"] = "sending";
      if (args.operation.endsWith("_finish")) job[args.operation.startsWith("email") ? "email_state" : "sms_state"] = args.payload.state;
      return { data: { ...job } };
    },
  };
  const module = loadModule("../src/lib/meta-sync.ts", {
    "./supabase/server": { adminDb: () => db }, "./meta": meta,
    "./gmail-crypto": { openGmail: () => ({ page_token: "token" }) },
    "./mail": { sendApplicationNotification: async () => { emails++; if (options.mailFails) throw new Error("private provider data"); return "receipt"; } },
  }, { process: { env: { SMTP_HOST: "smtp.example.com", SMTP_FROM: "hiring@example.com" } },
    fetch: async () => { texts++; if (options.quoTimeout) throw new Error("timeout"); return Response.json({ data: { id: "MSGtest" } }, { status: options.quoStatus || 202 }); } });
  return { run: () => module.processMetaLeads("company"), job, counts: () => ({ emails, texts }) };
}
test("delivery retries do not replay sent or uncertain messages, and revoked leases cannot send", async () => {
  const success = worker(); await success.run(); assert.deepEqual(success.counts(), { emails: 1, texts: 1 });
  assert.equal(success.job.email_state, "sent"); assert.equal(success.job.sms_state, "sent");
  const retry = worker({ email: "sent", sms: "uncertain" }); await retry.run(); assert.deepEqual(retry.counts(), { emails: 0, texts: 0 });
  const denied = worker({ leaseDenied: true }); await denied.run(); assert.deepEqual(denied.counts(), { emails: 0, texts: 0 });
  const timeout = worker({ mailFails: true, quoTimeout: true }); await timeout.run();
  assert.equal(timeout.job.email_state, "uncertain"); assert.equal(timeout.job.sms_state, "uncertain");
  const rejected = worker({ email: "sent", quoStatus: 429 }); await rejected.run(); assert.equal(rejected.job.sms_state, "pending");
});

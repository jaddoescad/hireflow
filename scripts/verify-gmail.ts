import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const base = process.env.APP_URL || "http://localhost:3101";
const users: string[] = [],
  companies: string[] = [];
const paths: string[] = [];
const run = randomBytes(4).toString("hex");
async function ok(p: PromiseLike<any>) {
  const r = await p;
  assert.equal(r.error, null, JSON.stringify(r.error));
  return r.data;
}
const mutate = (
  actor: string,
  cid: string | null,
  action: string,
  payload: unknown,
) => admin.rpc("hf_mutate", { actor, cid, action, payload });
async function user(label: string) {
  const email = `gmail-test-${run}-${label}@example.com`,
    password = randomBytes(24).toString("hex");
  const u = await ok(
    admin.auth.admin.createUser({ email, password, email_confirm: true }),
  );
  users.push(u.user.id);
  const jar = new Map<string, string>();
  const session = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (values) => values.forEach((v) => jar.set(v.name, v.value)),
      },
    },
  );
  await ok(session.auth.signInWithPassword({ email, password }));
  return {
    id: u.user.id,
    session,
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}
try {
  const a = await user("owner"),
    b = await user("outsider");
  const ca = await ok(
    mutate(a.id, null, "create_company", { name: `Gmail QA ${run}` }),
  );
  companies.push(ca.id);
  const cb = await ok(
    mutate(b.id, null, "create_company", { name: `Gmail QA other ${run}` }),
  );
  companies.push(cb.id);
  const stage = (
    await ok(admin.from("hf_stages").select("id").eq("company_id", ca.id))
  )[0];
  const c = await ok(
    mutate(a.id, ca.id, "candidate_save", {
      name: "Synthetic Email Candidate",
      email: "applicant@example.com",
      phone: "",
      job_title: "Painter",
      experience: "",
      tags: [],
      stage_id: stage.id,
    }),
  );
  assert((await a.session.from("hf_gmail_connections").select("*")).error);
  assert(
    (
      await admin.rpc("hf_gmail_set", {
        actor: b.id,
        cid: ca.id,
        mailbox_address: "hiring@example.com",
        encrypted_credentials: "encrypted-test-fixture",
      })
    ).error,
  );
  await ok(
    admin.rpc("hf_gmail_set", {
      actor: a.id,
      cid: ca.id,
      mailbox_address: "hiring@example.com",
      encrypted_credentials: "encrypted-test-fixture",
    }),
  );
  assert(
    (await admin.rpc("hf_gmail_claim", { cid: ca.id, actor: b.id })).error,
  );
  const connection = await ok(
    admin.rpc("hf_gmail_claim", { cid: ca.id, actor: a.id }),
  );
  assert(connection.lease_id);
  assert.equal(
    await ok(admin.rpc("hf_gmail_claim", { cid: ca.id, actor: a.id })),
    null,
  );
  const path = `${ca.id}/${connection.generation}/synthetic-resume`;
  paths.push(path);
  const bytes = Buffer.from("Synthetic resume attachment");
  await ok(
    admin.storage
      .from("hf-mail-attachments")
      .upload(path, bytes, { contentType: "application/pdf" }),
  );
  const payload = {
    direction: "incoming",
    body: "My resume is attached.",
    email: "applicant@example.com",
    contact_emails: ["applicant@example.com"],
    external_id: `gmail:${run}`,
    occurred_at: new Date().toISOString(),
    metadata: {
      subject: "Application",
      attachments: [{ path, name: "Synthetic Resume.pdf", size: bytes.length }],
    },
  };
  const ingest = () =>
    admin.rpc("hf_gmail_ingest", {
      cid: ca.id,
      connection_generation: connection.generation,
      worker: connection.lease_id,
      payload,
    });
  const id = await ok(ingest());
  assert.equal(await ok(ingest()), id);
  const activity = await ok(
    admin.from("hf_activities").select("candidate_id").eq("id", id).single(),
  );
  assert.equal(activity.candidate_id, c.id);
  assert(
    (
      await admin.rpc("hf_gmail_ingest", {
        cid: cb.id,
        connection_generation: connection.generation,
        worker: connection.lease_id,
        payload,
      })
    ).error,
  );
  const url = `${base}/api/gmail/attachments?company=${ca.id}&activity=${id}&file=0`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { Cookie: b.cookie() } })).status,
    403,
  );
  const download = await fetch(url, { headers: { Cookie: a.cookie() } });
  assert.equal(download.status, 200, await download.clone().text());
  assert.equal(await download.text(), bytes.toString());
  assert(download.headers.get("content-disposition")?.includes("attachment"));
  await ok(
    admin
      .from("hf_members")
      .insert({
        company_id: ca.id,
        user_id: b.id,
        email: `gmail-test-${run}-outsider@example.com`,
        role: "member",
        enabled: false,
      }),
  );
  assert.equal(
    (await fetch(url, { headers: { Cookie: b.cookie() } })).status,
    403,
  );
  assert(
    (await admin.rpc("hf_gmail_claim", { cid: ca.id, actor: b.id })).error,
  );
  await ok(
    admin
      .from("hf_members")
      .update({ enabled: true })
      .eq("company_id", ca.id)
      .eq("user_id", b.id),
  );
  assert.equal(
    (await fetch(url, { headers: { Cookie: b.cookie() } })).status,
    200,
  );
  assert(
    (await admin.rpc("hf_gmail_claim", { cid: ca.id, actor: b.id })).error,
  );
  assert(
    (await a.session.storage.from("hf-mail-attachments").download(path)).error,
  );
  const unknown = await ok(
    admin.rpc("hf_gmail_ingest", {
      cid: ca.id,
      connection_generation: connection.generation,
      worker: connection.lease_id,
      payload: {
        ...payload,
        external_id: `gmail:${run}:unknown`,
        email: "new@example.com",
        contact_emails: ["new@example.com"],
      },
    }),
  );
  assert.equal(
    (
      await ok(
        admin
          .from("hf_activities")
          .select("candidate_id")
          .eq("id", unknown)
          .single(),
      )
    ).candidate_id,
    null,
  );
  await ok(
    mutate(a.id, ca.id, "signal_link", { id: unknown, candidate_id: c.id }),
  );
  assert.equal(
    (
      await ok(
        admin
          .from("hf_activities")
          .select("candidate_id")
          .eq("id", unknown)
          .single(),
      )
    ).candidate_id,
    c.id,
  );
  await ok(
    admin.rpc("hf_gmail_set", {
      actor: a.id,
      cid: ca.id,
      mailbox_address: null,
      encrypted_credentials: null,
    }),
  );
  assert((await ingest()).error);
  // Disconnect stops future imports, but saved resumes remain accessible to the company.
  assert.equal(
    (await fetch(url, { headers: { Cookie: a.cookie() } })).status,
    200,
  );
  console.log(
    "PASS: Gmail tenant isolation, admin-only connection, private attachments, matching, unknown-mail linking, idempotency, exclusive sync lease and disconnect invalidation.",
  );
} finally {
  if (paths.length)
    await ok(admin.storage.from("hf-mail-attachments").remove(paths));
  for (const id of companies)
    await ok(admin.from("hf_companies").delete().eq("id", id));
  for (const id of users) await ok(admin.auth.admin.deleteUser(id));
  console.log("Removed Gmail test records and files.");
}

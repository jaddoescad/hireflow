import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, createHmac } from "node:crypto";
import assert from "node:assert/strict";
const base = process.env.APP_URL || "http://localhost:3100";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const users: string[] = [];
const companies: string[] = [];
const run = randomBytes(4).toString("hex");
async function account(label: string) {
  const email = `hf-http-${run}-${label}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.equal(error, null);
  users.push(data.user!.id);
  const cookies = new Map<string, string>();
  const session = createServerClient(url, key, {
    cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: (values) => values.forEach((c) => cookies.set(c.name, c.value)),
    },
  });
  const login = await session.auth.signInWithPassword({ email, password });
  assert.equal(login.error, null);
  return {
    email,
    id: data.user!.id,
    cookie: () => [...cookies].map(([n, v]) => `${n}=${v}`).join("; "),
  };
}
type Account = Awaited<ReturnType<typeof account>>;
async function request(
  path: string,
  body?: unknown,
  actor?: Account,
  headers: Record<string, string> = {},
) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(actor ? { Cookie: actor.cookie() } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
const mutate = (
  actor: Account,
  cid: string | null,
  action: string,
  payload: unknown,
) => request("/api/mutate", { company_id: cid, action, payload }, actor);
try {
  assert.equal((await request("/api/workspace")).status, 401);
  const a = await account("a"),
    b = await account("b");
  const company = await mutate(a, null, "create_company", {
    name: `HTTP QA ${run}`,
  });
  assert.equal(company.status, 200, JSON.stringify(company));
  const cid = company.data.id;
  companies.push(cid);
  const state = await request(`/api/workspace?company=${cid}`, undefined, a);
  assert.equal(state.status, 200);
  assert.equal(state.data.stages.length, 7);
  assert.equal(state.data.membership.role, "admin");
  assert.equal(
    (await request(`/api/workspace?company=${cid}`, undefined, b)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/mutate",
        { company_id: cid, action: "rename_company", payload: { name: "no" } },
        a,
        { Origin: "https://evil.example" },
      )
    ).status,
    400,
  );
  const candidate = await mutate(a, cid, "candidate_save", {
    stage_id: state.data.stages[0].id,
    name: "HTTP Candidate",
    phone: "6135550123",
    email: "HTTP@EXAMPLE.COM",
    job_title: "Painter",
    experience: "2 years",
    tags: ["Interior"],
  });
  assert.equal(candidate.status, 200, JSON.stringify(candidate));
  const settings = await mutate(a, cid, "integration", {
    rotate_intake: true,
    quo_phone_id: "PNtest",
    quo_phone: "+13433265133",
    quo_signing_secret: Buffer.from("webhook-test-secret").toString("base64"),
  });
  assert.equal(settings.status, 200);
  const token = settings.data.intake_key;
  const payload = {
    source_id: "123",
    name: "Webhook Candidate",
    phone: "6135550456",
    email: "webhook@example.com",
  };
  assert.equal((await request("/api/webhooks/intake", payload)).status, 401);
  const ingested = await request("/api/webhooks/intake", payload, undefined, {
    Authorization: `Bearer ${token}`,
  });
  assert.equal(ingested.status, 200, JSON.stringify(ingested));
  const duplicate = await request("/api/webhooks/intake", payload, undefined, {
    Authorization: `Bearer ${token}`,
  });
  assert.equal(duplicate.data.id, ingested.data.id);
  assert.equal(duplicate.data.duplicate, true);
  const event = {
    id: "event",
    type: "message.received",
    data: {
      object: {
        id: "MSGtest",
        phoneNumberId: "PNtest",
        direction: "incoming",
        from: "+16135550123",
        to: ["+13433265133"],
        body: "Synthetic webhook message",
        createdAt: new Date().toISOString(),
      },
    },
  };
  const timestamp = Date.now();
  const digest = createHmac("sha256", "webhook-test-secret")
    .update(`${timestamp}.${JSON.stringify(event)}`)
    .digest("base64");
  assert.equal((await request(`/api/webhooks/quo/${cid}`, event)).status, 401);
  const eventResult = await request(
    `/api/webhooks/quo/${cid}`,
    event,
    undefined,
    { "openphone-signature": `hmac;1;${timestamp};${digest}` },
  );
  assert.equal(eventResult.status, 200, JSON.stringify(eventResult));
  const after = await request(`/api/workspace?company=${cid}`, undefined, a);
  assert.equal(after.data.candidates.length, 2);
  assert.equal(after.data.activities[0].candidate_id, candidate.data.id);
  assert.equal(after.data.activities[0].body, "Synthetic webhook message");
  assert(!JSON.stringify(after.data).includes("webhook-test-secret"));
  assert(!JSON.stringify(after.data).includes(token));
  const historyUrl = `/api/activities?company=${cid}&candidate=${candidate.data.id}`;
  assert.equal((await request(historyUrl, undefined, b)).status, 403);
  const insertHistory = await admin.from("hf_activities").insert(
    Array.from({ length: 51 }, (_, i) => ({
      company_id: cid,
      candidate_id: candidate.data.id,
      kind: "note",
      body: `History item ${i}`,
      occurred_at: new Date(Date.now() - i * 1000).toISOString(),
    })),
  );
  assert.equal(insertHistory.error, null);
  const firstHistory = await request(historyUrl, undefined, a);
  assert.equal(firstHistory.data.activities.length, 50);
  assert.equal(firstHistory.data.has_more, true);
  const secondHistory = await request(historyUrl + "&page=1", undefined, a);
  assert.equal(secondHistory.data.activities.length, 2);
  assert.equal(secondHistory.data.has_more, false);
  assert.equal(
    new Set(
      [...firstHistory.data.activities, ...secondHistory.data.activities].map(
        (x) => x.id,
      ),
    ).size,
    52,
  );
  // Chat filtering happens before pagination: notes and stage changes never hide SMS.
  await mutate(a, cid, "move", {
    id: candidate.data.id,
    stage_id: state.data.stages[1].id,
  });
  const chat = await request(historyUrl + "&chat=1", undefined, a);
  assert.equal(chat.status, 200);
  assert.equal(chat.data.activities.length, 1);
  assert.equal(chat.data.activities[0].kind, "sms");
  assert.equal(chat.data.has_more, false);
  const notes = await request(historyUrl + "&notes=1", undefined, a);
  assert(
    notes.data.activities.every(
      (item: { kind: string }) => item.kind === "note",
    ),
  );
  assert.equal(
    (await request(historyUrl + "&chat=1", undefined, b)).status,
    403,
  );
  const invited = await mutate(a, cid, "invite", {
    email: b.email,
    role: "member",
  });
  assert.equal(invited.status, 200, JSON.stringify(invited));
  assert(invited.data.invitation_url);
  const invitationToken = new URL(invited.data.invitation_url).searchParams.get(
    "invite",
  );
  assert.equal(
    (await mutate(a, null, "accept_invitation", { token: invitationToken }))
      .status,
    400,
  );
  assert.equal(
    (await mutate(b, null, "accept_invitation", { token: invitationToken }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/api/workspace?company=${cid}`, undefined, b)).status,
    200,
  );
  assert.equal(
    (await mutate(b, cid, "integration", { rotate_intake: true })).status,
    400,
  );
  await mutate(a, cid, "member", {
    user_id: b.id,
    role: "member",
    enabled: false,
  });
  assert.equal(
    (await request(`/api/workspace?company=${cid}`, undefined, b)).status,
    403,
  );
  assert.equal(
    (
      await mutate(b, cid, "note", {
        candidate_id: candidate.data.id,
        body: "No access",
      })
    ).status,
    400,
  );
  console.log(
    "PASS: HTTP sessions, origin checks, company authorization, candidate creation, authenticated intake/retries, signed Quo events, secret redaction, invitation acceptance, and membership revocation.",
  );
} finally {
  for (const id of companies) {
    const r = await admin.from("hf_companies").delete().eq("id", id);
    assert.equal(r.error, null);
  }
  for (const id of users) {
    const r = await admin.auth.admin.deleteUser(id);
    assert.equal(r.error, null);
  }
  console.log("Removed HTTP test data.");
}

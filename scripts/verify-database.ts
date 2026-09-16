import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
assert(url && key && service, "Load your env file first");
const admin = createClient(url, service, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const run = randomBytes(5).toString("hex");
const users: string[] = [];
const companies: string[] = [];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const mutate = (
  actor: string,
  cid: string | null,
  action: string,
  payload: unknown,
) => admin.rpc("hf_mutate", { actor, cid, action, payload });
async function ok<T extends { error: unknown; data: unknown }>(
  request: PromiseLike<T>,
) {
  const r = await request;
  assert.equal(r.error, null, JSON.stringify(r.error));
  return r.data as any;
}
try {
  async function make(label: string) {
    const email = `hf-test-${run}-${label}@example.com`,
      password = randomBytes(24).toString("hex");
    const u = await ok(
      admin.auth.admin.createUser({ email, password, email_confirm: true }),
    );
    users.push(u.user.id);
    const db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await ok(db.auth.signInWithPassword({ email, password }));
    return { id: u.user.id, email, db };
  }
  const a = await make("a"),
    b = await make("b"),
    other = await make("other");
  const ca = await ok(
    mutate(a.id, null, "create_company", { name: `HF verification A ${run}` }),
  );
  companies.push(ca.id);
  const cb = await ok(
    mutate(other.id, null, "create_company", {
      name: `HF verification B ${run}`,
    }),
  );
  companies.push(cb.id);
  assert.equal((await ok(a.db.from("hf_companies").select("*"))).length, 1);
  assert.equal((await ok(b.db.from("hf_companies").select("*"))).length, 0);
  assert.equal(
    (await a.db.from("hf_integrations").select("*")).error?.code,
    "42501",
  );
  assert.equal(
    (
      await a.db.rpc("hf_mutate", {
        actor: a.id,
        cid: ca.id,
        action: "rename_company",
        payload: { name: "no" },
      })
    ).error?.code,
    "42501",
  );
  assert(
    (
      await a.db
        .from("hf_candidates")
        .insert({ company_id: ca.id, name: "Forbidden" })
    ).error,
  );
  const stages = await ok(
    a.db
      .from("hf_stages")
      .select("*")
      .eq("company_id", ca.id)
      .order("position"),
  );
  assert.equal(stages.length, 7);
  const c = await ok(
    mutate(a.id, ca.id, "candidate_save", {
      stage_id: stages[0].id,
      name: "Synthetic Candidate",
      phone: "+16135550123",
      email: "candidate@example.com",
      job_title: "Painter",
      experience: "3 years",
      tags: ["Own vehicle"],
    }),
  );
  assert.equal(
    (
      await ok(
        other.db.from("hf_candidates").select("*").eq("company_id", ca.id),
      )
    ).length,
    0,
  );
  assert(
    (
      await mutate(other.id, ca.id, "move", {
        id: c.id,
        stage_id: stages[1].id,
      })
    ).error,
  );
  const otherStages = await ok(
    other.db.from("hf_stages").select("*").eq("company_id", cb.id),
  );
  assert(
    (
      await mutate(a.id, ca.id, "move", {
        id: c.id,
        stage_id: otherStages[0].id,
      })
    ).error,
  );
  await ok(mutate(a.id, ca.id, "move", { id: c.id, stage_id: stages[1].id }));
  await ok(
    mutate(a.id, ca.id, "note", {
      candidate_id: c.id,
      body: "Synthetic verification note",
    }),
  );
  const token = randomBytes(32).toString("hex");
  await ok(
    mutate(a.id, ca.id, "invite", {
      email: b.email,
      role: "member",
      token_hash: hash(token),
    }),
  );
  assert(
    (
      await mutate(other.id, null, "accept_invitation", {
        token_hash: hash(token),
      })
    ).error,
  );
  await ok(
    mutate(b.id, null, "accept_invitation", { token_hash: hash(token) }),
  );
  await ok(
    mutate(b.id, null, "accept_invitation", { token_hash: hash(token) }),
  );
  assert.equal((await ok(b.db.from("hf_candidates").select("*"))).length, 1);
  // An invitation must also work when the account is created after it was sent.
  const lateEmail = `hf-test-${run}-late@example.com`;
  const lateToken = randomBytes(32).toString("hex");
  await ok(mutate(a.id, ca.id, "invite", {
    email: lateEmail, role: "member", token_hash: hash(lateToken),
  }));
  const late = await make("late");
  await ok(mutate(late.id, null, "accept_invitation", { token_hash: hash(lateToken) }));
  assert.equal((await ok(late.db.from("hf_companies").select("id"))).length, 1);

  const expiredToken = randomBytes(32).toString("hex");
  const expired = await ok(mutate(a.id, ca.id, "invite", {
    email: other.email, role: "member", token_hash: hash(expiredToken),
  }));
  await ok(admin.from("hf_invitations").update({ expires_at: "2020-01-01T00:00:00Z" }).eq("id", expired.id));
  assert((await mutate(other.id, null, "accept_invitation", { token_hash: hash(expiredToken) })).error);

  const revokedToken = randomBytes(32).toString("hex");
  const revoked = await ok(mutate(a.id, ca.id, "invite", {
    email: other.email, role: "member", token_hash: hash(revokedToken),
  }));
  await ok(mutate(a.id, ca.id, "revoke_invitation", { id: revoked.id }));
  assert((await mutate(other.id, null, "accept_invitation", { token_hash: hash(revokedToken) })).error);

  assert(
    (
      await mutate(b.id, ca.id, "invite", {
        email: "new@example.com",
        role: "admin",
        token_hash: hash("bad"),
      })
    ).error,
  );
  await ok(
    mutate(b.id, ca.id, "note", {
      candidate_id: c.id,
      body: "Member can add a note",
    }),
  );
  await ok(
    mutate(a.id, ca.id, "member", {
      user_id: b.id,
      role: "member",
      enabled: false,
    }),
  );
  assert.equal((await ok(b.db.from("hf_candidates").select("*"))).length, 0);
  assert(
    (await mutate(b.id, ca.id, "note", { candidate_id: c.id, body: "Denied" }))
      .error,
  );
  assert(
    (
      await mutate(a.id, ca.id, "member", {
        user_id: a.id,
        role: "admin",
        enabled: false,
      })
    ).error,
  );
  const token2 = randomBytes(32).toString("hex");
  await ok(
    mutate(other.id, cb.id, "invite", {
      email: b.email,
      role: "member",
      token_hash: hash(token2),
    }),
  );
  await ok(
    mutate(b.id, null, "accept_invitation", { token_hash: hash(token2) }),
  );
  assert.equal((await ok(b.db.from("hf_companies").select("*"))).length, 1);
  await ok(
    mutate(a.id, ca.id, "member", {
      user_id: b.id,
      role: "admin",
      enabled: true,
    }),
  );
  assert.equal((await ok(b.db.from("hf_companies").select("*"))).length, 2);
  const concurrent = await Promise.all([
    mutate(a.id, ca.id, "member", {
      user_id: a.id,
      role: "member",
      enabled: true,
    }),
    mutate(b.id, ca.id, "member", {
      user_id: b.id,
      role: "member",
      enabled: true,
    }),
  ]);
  assert.equal(concurrent.filter((r) => r.error).length, 1);
  const currentAdmin = (
    await ok(
      admin
        .from("hf_members")
        .select("*")
        .eq("company_id", ca.id)
        .eq("role", "admin")
        .eq("enabled", true),
    )
  )[0].user_id;
  await ok(
    mutate(currentAdmin, ca.id, "stage_reorder", {
      id: stages[1].id,
      direction: "up",
    }),
  );
  const reordered = await ok(
    admin
      .from("hf_stages")
      .select("*")
      .eq("company_id", ca.id)
      .order("position"),
  );
  assert.equal(reordered[0].id, stages[1].id);
  const added = await Promise.all(
    ["References", "Offer"].map((name) =>
      ok(mutate(currentAdmin, ca.id, "stage_save", { name, color: "blue" })),
    ),
  );
  const appended = await ok(
    admin
      .from("hf_stages")
      .select("id,position")
      .eq("company_id", ca.id)
      .order("position"),
  );
  assert.equal(
    new Set(appended.map((s: { position: number }) => s.position)).size,
    9,
  );
  assert.deepEqual(
    new Set(appended.slice(-2).map((s: { id: string }) => s.id)),
    new Set(added.map((s) => s.id)),
  );
  await ok(
    mutate(currentAdmin, ca.id, "stage_save", {
      id: stages[1].id,
      name: "Phone interview",
      color: "blue",
      position: 99,
    }),
  );
  const edited = await ok(
    admin.from("hf_stages").select("position").eq("id", stages[1].id).single(),
  );
  assert.equal(edited.position, reordered[0].position);
  const application = {
    source_id: "lead-123",
    source: "Meta",
    name: "Second Synthetic Candidate",
    phone: "+16135550456",
    email: "second@example.com",
    job_title: "Painter",
    experience: "5 years",
    tags: [],
    attributes: { vehicle: true },
  };
  const retries = await Promise.all(
    Array.from({ length: 4 }, () =>
      admin.rpc("hf_ingest", {
        cid: ca.id,
        event_kind: "intake",
        payload: application,
      }),
    ),
  );
  for (const r of retries) assert.equal(r.error, null);
  assert.equal(new Set(retries.map((r) => r.data.id)).size, 1);
  const event = {
    external_id: "quo:sms:test",
    kind: "sms",
    direction: "incoming",
    body: "Synthetic message",
    phone: "+16135550123",
    occurred_at: new Date().toISOString(),
  };
  await ok(
    admin.rpc("hf_ingest", { cid: ca.id, event_kind: "quo", payload: event }),
  );
  await ok(
    admin.rpc("hf_ingest", { cid: ca.id, event_kind: "quo", payload: event }),
  );
  const messages = await ok(
    admin
      .from("hf_activities")
      .select("*")
      .eq("company_id", ca.id)
      .eq("external_id", event.external_id),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].candidate_id, c.id);
  assert.equal(
    (
      await ok(
        admin.rpc("hf_ingest", {
          cid: cb.id,
          event_kind: "quo",
          payload: event,
        }),
      )
    ).ignored,
    true,
  );
  await ok(
    mutate(currentAdmin, ca.id, "candidate_save", {
      stage_id: stages[0].id,
      name: "Shared Phone",
      phone: "+16135550123",
      email: "different@example.com",
      job_title: "Painter",
      experience: "",
      tags: [],
    }),
  );
  await ok(
    admin.rpc("hf_ingest", {
      cid: ca.id,
      event_kind: "quo",
      payload: { ...event, external_id: "quo:sms:ambiguous" },
    }),
  );
  assert.equal(
    (
      await ok(
        admin
          .from("hf_activities")
          .select("*")
          .eq("external_id", "quo:sms:ambiguous")
          .eq("company_id", ca.id),
      )
    )[0].candidate_id,
    null,
  );
  console.log(
    "PASS: company isolation, server-only writes/secrets, cross-company FKs, invite identity/idempotency, multi-company membership, immediate disable, concurrent last-admin protection, stages/notes, intake retries, Quo isolation and ambiguous matching.",
  );
} finally {
  for (const cid of companies)
    await ok(admin.from("hf_companies").delete().eq("id", cid));
  for (const id of users) await ok(admin.auth.admin.deleteUser(id));
  console.log("Removed synthetic verification companies and users.");
}

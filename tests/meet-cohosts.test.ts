import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("room reconciliation promotes enabled company members and removes revoked members", async () => {
  const filters: unknown[][] = [];
  const query = {
    select() { return this; },
    eq(...args: unknown[]) { filters.push(args); return this; },
    then(resolve: (value: unknown) => unknown) { return resolve({ data: [
      { email: "organizer@example.test" }, { email: "internal@example.test" }, { email: "other@example.test" },
    ], error: null }); },
  };
  const exports: { syncCohosts?: (...args: unknown[]) => Promise<unknown> } = {};
  const source = readFileSync(new URL("../src/lib/meet.ts", import.meta.url), "utf8") + "\nexport { syncCohosts };";
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => name === "./supabase/server"
    ? { adminDb: () => ({ from: () => query }) } : {}, URL, URLSearchParams, Date });
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const google = async (url: string, method = "GET", body?: unknown) => {
    requests.push({ url, method, body });
    return method === "GET" ? { members: [
      { name: "spaces/test/members/internal", email: "internal@example.test", role: "ROLE_UNSPECIFIED" },
      { name: "spaces/test/members/revoked", email: "revoked@example.test", role: "COHOST" },
    ] } : {};
  };
  await exports.syncCohosts!("company-test", { organizer: "organizer@example.test", interviewer_ids: [] }, "spaces/test", google, Date.now() + 10000);
  assert.deepEqual(filters, [["company_id", "company-test"], ["enabled", true]]);
  assert.ok(requests.some(r => r.method === "DELETE" && r.url.endsWith("/revoked")));
  assert.ok(requests.some(r => r.method === "PATCH" && r.url.endsWith("/internal?updateMask=role") && (r.body as {role:string}).role === "COHOST"));
  assert.ok(requests.some(r => r.method === "POST" && (r.body as {email:string}).email === "other@example.test"));
  assert.ok(!requests.some(r => r.method === "POST" && (r.body as {email:string}).email === "organizer@example.test"));
});

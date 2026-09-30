import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Exercise the actual route with external identity verification and database processing replaced.
const source = readFileSync(new URL("../src/app/api/meet/events/route.ts", import.meta.url), "utf8");
function route(handle: () => Promise<boolean>, identity = "push@example.test") {
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "google-auth-library": { OAuth2Client: class {
      async verifyIdToken() { return { getPayload: () => ({ email_verified: true, email: identity }) }; }
    } },
    zod: { z },
    "@/lib/meet": { handleMeetEvent: handle },
    "@/lib/http": { bodyJson: (request: Request) => request.json() },
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => modules[name], Buffer, URL,
    process: { env: { APP_URL: "https://hireflow.example.test", MEET_EVENTS_PUSH_ACCOUNT: "push@example.test" } } });
  return exports.POST!;
}
function event(payload: unknown = { conferenceRecord: { name: "conferenceRecords/synthetic" } }, authenticated = true) {
  return new Request("https://hireflow.example.test/api/meet/events", {
    method: "POST", headers: authenticated ? { authorization: "Bearer synthetic-token" } : {},
    body: JSON.stringify({ message: {
      attributes: { "ce-source": "//workspaceevents.googleapis.com/subscriptions/synthetic", "ce-type": "google.workspace.meet.conference.v2.started" },
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
    } }),
  });
}
test("Meet push acknowledges completed events and retries busy or failed processing", async () => {
  assert.equal((await route(async () => false)(event())).status, 204);
  assert.equal((await route(async () => true)(event())).status, 503);
  const failed = await route(async () => { throw new Error("private provider details"); })(event());
  assert.equal(failed.status, 503);
  assert.equal(await failed.text(), "Retry");
});
test("Meet push rejects untrusted identities and malformed events before processing", async () => {
  let calls = 0;
  const handler = async () => { calls++; return false; };
  assert.equal((await route(handler)(event({}, false))).status, 401);
  assert.equal((await route(handler, "wrong@example.test")(event())).status, 401);
  assert.equal((await route(handler)(event({ conferenceRecord: null }))).status, 400);
  assert.equal(calls, 0);
});

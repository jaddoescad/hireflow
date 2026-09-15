import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizePhone, intakeSchema } from "../src/lib/validation";
import { verifyQuoSignature } from "../src/lib/crypto";
import { parseQuoEvent } from "../src/lib/quo";
test("phone and email normalization preserves international identity", () => {
  assert.equal(normalizePhone("(613) 555-0123"), "+16135550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.throws(() => normalizePhone("123"));
  const p = intakeSchema.parse({
    source_id: "123",
    name: "Alex",
    email: " ALEX@example.com ",
    phone: "6135550123",
  });
  assert.equal(p.email, "alex@example.com");
  assert.equal(p.phone, "+16135550123");
  assert.throws(() => intakeSchema.parse({ name: "Alex", source_id: "123" }));
});
test("Quo signatures reject tampering, stale events and invalid lengths", () => {
  const payload = { id: "event", body: "hello world" };
  const now = Date.now();
  const secret = Buffer.from("test-signing-secret").toString("base64");
  const digest = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${now}.${JSON.stringify(payload)}`)
    .digest("base64");
  const header = `hmac;1;${now};${digest}`;
  assert.equal(verifyQuoSignature(payload, header, secret, now), true);
  assert.equal(
    verifyQuoSignature({ ...payload, body: "tampered" }, header, secret, now),
    false,
  );
  assert.equal(
    verifyQuoSignature(payload, header, secret, now + 300001),
    false,
  );
  assert.equal(
    verifyQuoSignature(payload, `hmac;1;${now};x`, secret, now),
    false,
  );
});
test("Quo matches exact line and excludes group conversations", () => {
  const event = {
    id: "e",
    type: "message.received",
    data: {
      object: {
        id: "m",
        phoneNumberId: "PNtest",
        direction: "incoming",
        from: "+16135550123",
        to: ["+13433265133"],
        body: "Hello",
        createdAt: "2026-09-15T12:00:00Z",
      },
    },
  };
  assert.equal(
    parseQuoEvent(event, "PNtest", "+13433265133")?.phone,
    "+16135550123",
  );
  assert.equal(parseQuoEvent(event, "PNother", "+13433265133"), null);
  assert.equal(
    parseQuoEvent(
      {
        ...event,
        data: {
          object: {
            ...event.data.object,
            to: ["+13433265133", "+16135550456"],
          },
        },
      },
      "PNtest",
      "+13433265133",
    ),
    null,
  );
});

test("Hiring Sheet import keeps answers and stable identity across row sorting", async () => {
  const { mapHiringRow } = await import("../src/lib/import-mapping");
  const headers = [
    " ",
    "Full Name",
    "Email",
    "Phone Number",
    "Years Painting Experience",
    "Position Applied For",
    "Led Crew Before",
    "Transportation Answer",
    "Start Availability",
    "Applicant Type",
    "Notes",
    "Decision",
  ];
  const row = [
    "2026-09-01",
    "Alex Example",
    "alex@example.com",
    "6135550123",
    "3 years",
    "Painter",
    "Yes",
    "Yes",
    "Next week",
    "Interior",
    "Interview notes",
    "Contact later",
  ];
  const a = mapHiringRow(headers, row, "sheet", 2)!;
  const b = mapHiringRow(headers, row, "sheet", 90)!;
  assert.equal(a.source_id, b.source_id);
  assert.deepEqual(a.tags, [
    "Interior",
    "Crew lead experience",
    "Own transportation",
  ]);
  assert.equal(a.attributes.Decision, "Contact later");
  assert.equal(a.attributes.Notes, "Interview notes");
  assert.equal(a.phone, "+16135550123");
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealGmail, openGmail } from "../src/lib/gmail-crypto";
import {
  loadGmailTextParts,
  parseGmailMessage,
  type GmailMessage,
} from "../src/lib/gmail-message";
const encoded = (text: string) => Buffer.from(text).toString("base64url");
test("stored Gmail credentials reject tampering and the wrong encryption key", () => {
  const previous = process.env.GMAIL_TOKEN_KEY;
  try {
    process.env.GMAIL_TOKEN_KEY = randomBytes(32).toString("base64");
    const value = { refresh_token: "synthetic-refresh-token" };
    const sealed = sealGmail(value);
    assert.deepEqual(openGmail(sealed), value);
    assert.notEqual(sealGmail(value), sealed);
    const changed = Buffer.from(sealed, "base64url");
    changed[changed.length - 1] ^= 1;
    assert.throws(() => openGmail(changed.toString("base64url")));
    process.env.GMAIL_TOKEN_KEY = randomBytes(32).toString("base64");
    assert.throws(() => openGmail(sealed));
  } finally {
    if (previous === undefined) delete process.env.GMAIL_TOKEN_KEY;
    else process.env.GMAIL_TOKEN_KEY = previous;
  }
});
const fixture: GmailMessage = {
  id: "message-1",
  threadId: "thread-1",
  internalDate: "1789560000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: '"Alex, Morgan" <ALEX@example.com>' },
      { name: "To", value: "hiring@example.com" },
      { name: "Subject", value: "My resume" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: encoded("Please find my resume attached.") },
          },
          {
            mimeType: "text/html",
            body: { data: encoded("<p>Duplicate HTML</p>") },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "Alex Resume.pdf",
        body: { attachmentId: "private-file", size: 1024 },
      },
    ],
  },
};
test("Gmail maps sender to candidate and keeps nested resume metadata without duplicate alternative bodies", () => {
  const m = parseGmailMessage(fixture, "hiring@example.com");
  assert.deepEqual(m.contact_emails, ["alex@example.com"]);
  assert.equal(m.direction, "incoming");
  assert.equal(m.body, "Please find my resume attached.");
  assert.equal(m.attachments[0].name, "Alex Resume.pdf");
  assert.equal(m.attachments[0].attachment_id, "private-file");
  assert.equal(
    m.external_id,
    parseGmailMessage(fixture, "hiring@example.com").external_id,
  );
});
test("sent mail uses recipients, excludes mailbox and preserves ambiguity", () => {
  const m = parseGmailMessage(
    {
      ...fixture,
      labelIds: ["SENT"],
      payload: {
        headers: [
          { name: "From", value: "hiring@example.com" },
          { name: "To", value: "Alex <alex@example.com>, sam@example.com" },
          { name: "Cc", value: "hiring@example.com" },
        ],
      },
    },
    "hiring@example.com",
  );
  assert.equal(m.direction, "outgoing");
  assert.deepEqual(m.contact_emails, ["alex@example.com", "sam@example.com"]);
  assert.equal(m.email, null);
});
test("arbitrary mail cannot spoof a candidate using an Email line", () => {
  const msg = {
    ...fixture,
    payload: {
      headers: [{ name: "From", value: "notifier@example.com" }],
      mimeType: "text/plain",
      body: { data: encoded("Email: alex@example.com") },
    },
  };
  assert.deepEqual(
    parseGmailMessage(msg, "hiring@example.com").contact_emails,
    ["notifier@example.com"],
  );
  assert.deepEqual(
    parseGmailMessage(msg, "hiring@example.com", ["notifier@example.com"])
      .contact_emails,
    ["alex@example.com"],
  );
});
test("HTML-only mail is displayed as text and attachments remain separate", () => {
  const m = parseGmailMessage(
    {
      ...fixture,
      payload: {
        mimeType: "text/html",
        body: {
          data: encoded(
            '<p>Hello</p><script>alert(1)</script><img src="https://tracker.invalid">',
          ),
        },
      },
    },
    "hiring@example.com",
  );
  assert.equal(m.body, "Hello");
  assert.equal(m.attachments.length, 0);
});
test("separately stored text bodies load without consuming resume attachments", async () => {
  const msg: GmailMessage = {
    ...fixture,
    payload: {
      parts: [
        {
          mimeType: "text/plain",
          headers: [
            {
              name: "Content-Type",
              value: 'text/plain; charset="windows-1252"',
            },
          ],
          body: { attachmentId: "body" },
        },
        {
          mimeType: "application/pdf",
          filename: "Resume.pdf",
          body: { attachmentId: "resume" },
        },
      ],
    },
  };
  const requested: string[] = [];
  await loadGmailTextParts(msg.payload!, async (id) => {
    requested.push(id);
    return Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url");
  });
  assert.deepEqual(requested, ["body"]);
  const parsed = parseGmailMessage(msg, "hiring@example.com");
  assert.equal(parsed.body, "café");
  assert.equal(parsed.attachments[0].attachment_id, "resume");
});

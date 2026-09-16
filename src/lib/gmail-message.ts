import addressParser from "nodemailer/lib/addressparser/index.js";
import { convert } from "html-to-text";
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload?: GmailPart;
};
export type MailAttachment = {
  part: string;
  name: string;
  mime_type: string;
  size: number;
  attachment_id?: string;
  data?: string;
};
function addresses(value: string) {
  return addressParser(value, { flatten: true })
    .map((a) => ("address" in a ? (a.address || "").trim().toLowerCase() : ""))
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
}
export async function loadGmailTextParts(
  part: GmailPart,
  load: (attachmentId: string) => Promise<string>,
): Promise<void> {
  if (part.filename) return;
  if (
    ["text/plain", "text/html"].includes(part.mimeType || "") &&
    !part.body?.data &&
    part.body?.attachmentId
  )
    part.body.data = await load(part.body.attachmentId);
  for (const child of part.parts || []) await loadGmailTextParts(child, load);
}
export function parseGmailMessage(
  message: GmailMessage,
  mailbox: string,
  applicationSenders: string[] = [],
) {
  const payload = message.payload || {};
  const header = (name: string) =>
    payload.headers?.find((h) => h.name.toLowerCase() === name)?.value || "";
  const from = addresses(header("from"));
  const to = addresses([header("to"), header("cc"), header("bcc")].join(","));
  const outgoing =
    message.labelIds?.includes("SENT") || from.includes(mailbox.toLowerCase());
  const direction = outgoing ? "outgoing" : "incoming";
  const text: string[] = [],
    html: string[] = [],
    attachments: MailAttachment[] = [];
  function visit(part: GmailPart, position: string) {
    if (part.filename) {
      attachments.push({
        part: part.partId || position,
        name: part.filename.slice(0, 240),
        mime_type: part.mimeType || "application/octet-stream",
        size: part.body?.size || 0,
        attachment_id: part.body?.attachmentId,
        data: part.body?.data,
      });
      return;
    }
    if (part.body?.data) {
      const bytes = Buffer.from(part.body.data, "base64url");
      const contentType =
        part.headers?.find((h) => h.name.toLowerCase() === "content-type")
          ?.value || "";
      const charset =
        contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || "utf-8";
      let value: string;
      try {
        value = new TextDecoder(charset).decode(bytes);
      } catch {
        value = bytes.toString("utf8");
      }
      if (part.mimeType === "text/plain") text.push(value);
      else if (part.mimeType === "text/html") html.push(value);
    }
    part.parts?.forEach((child, i) => visit(child, `${position}.${i}`));
  }
  visit(payload, "0");
  const body = (
    text.length
      ? text.join("\n")
      : convert(html.join("\n"), {
          wordwrap: false,
          selectors: [
            { selector: "img", format: "skip" },
            { selector: "a", options: { ignoreHref: true } },
          ],
        })
  ).slice(0, 100000);
  let peers = outgoing ? to : from;
  // Only an explicitly configured application notifier may supply a contact in its body.
  if (!outgoing && from.length === 1 && applicationSenders.includes(from[0])) {
    const applicationEmail = body.match(
      /^Email:\s*([^\s<>]+@[^\s<>]+)\s*$/im,
    )?.[1];
    if (applicationEmail) peers = addresses(applicationEmail);
  }
  peers = [
    ...new Set(peers.filter((email) => email !== mailbox.toLowerCase())),
  ];
  const timestamp = Number(message.internalDate);
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    throw new Error("Invalid Gmail timestamp");
  return {
    direction,
    body,
    contact_emails: peers,
    email: peers.length === 1 ? peers[0] : null,
    external_id: `gmail:${mailbox.toLowerCase()}:${message.id}`,
    occurred_at: new Date(timestamp).toISOString(),
    attachments,
    metadata: {
      gmail_id: message.id,
      thread_id: message.threadId,
      mailbox: mailbox.toLowerCase(),
      subject: header("subject").slice(0, 1000),
      from,
      to,
    },
  };
}

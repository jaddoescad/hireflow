import "server-only";
import { OAuth2Client } from "google-auth-library";
import { createHash } from "node:crypto";
import { adminDb, sessionDb } from "./supabase/server";
import { openGmail } from "./gmail-crypto";
import {
  loadGmailTextParts,
  parseGmailMessage,
  type GmailMessage,
} from "./gmail-message";
export const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
export const attachmentBucket = "hf-mail-attachments";
export function gmailOAuth() {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.GMAIL_TOKEN_KEY
  )
    throw new Error("Gmail connection is not configured on this server.");
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${new URL(process.env.APP_URL!).origin}/api/gmail/callback`,
  );
}
export async function gmailAdmin(company: string) {
  const db = await sessionDb();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new Error("Sign in to continue.");
  const { data, error } = await db
    .from("hf_members")
    .select("role,enabled")
    .eq("company_id", company)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data?.enabled || data.role !== "admin")
    throw new Error("Admin access required.");
  return user;
}
type Connection = {
  company_id: string;
  generation: string;
  mailbox: string;
  credentials: string;
  history_id: string | null;
  history_page: string | null;
  bootstrap_page: string | null;
  bootstrap_started: boolean;
  lease_id: string;
};
function status(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status;
}
export async function syncGmail(company: string, actor: string | null = null) {
  const started = Date.now();
  const client = gmailOAuth();
  const db = adminDb();
  const claim = await db.rpc("hf_gmail_claim", { cid: company, actor });
  if (claim.error) throw new Error(claim.error.message);
  const connection = claim.data as Connection | null;
  if (!connection) return { synced: 0, busy: true };
  const get = async <T>(path: string) =>
    (
      await client.request<T>({
        url: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        timeout: 30000,
      })
    ).data;
  const update = async (values: Record<string, unknown>) => {
    const result = await db
      .from("hf_gmail_connections")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("company_id", company)
      .eq("generation", connection.generation)
      .eq("lease_id", connection.lease_id);
    if (result.error) throw result.error;
  };
  let synced = 0;
  try {
    client.setCredentials(
      openGmail<{ refresh_token: string }>(connection.credentials),
    );
    let ids: string[] = [];
    let checkpoint: Record<string, unknown>;
    if (!connection.bootstrap_started || connection.bootstrap_page) {
      const baseline =
        connection.history_id ||
        (await get<{ historyId: string }>("profile")).historyId;
      const params = new URLSearchParams({
        maxResults: "50",
        includeSpamTrash: "false",
      });
      if (connection.bootstrap_page)
        params.set("pageToken", connection.bootstrap_page);
      const page = await get<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(`messages?${params}`);
      ids = page.messages?.map((m) => m.id) || [];
      checkpoint = {
        history_id: baseline,
        bootstrap_started: true,
        bootstrap_page: page.nextPageToken || null,
      };
    } else {
      const params = new URLSearchParams({
        startHistoryId: connection.history_id!,
        historyTypes: "messageAdded",
        maxResults: "100",
      });
      if (connection.history_page)
        params.set("pageToken", connection.history_page);
      try {
        const page = await get<{
          history?: { messagesAdded?: { message: { id: string } }[] }[];
          historyId: string;
          nextPageToken?: string;
        }>(`history?${params}`);
        ids = [
          ...new Set(
            page.history?.flatMap(
              (h) => h.messagesAdded?.map((m) => m.message.id) || [],
            ) || [],
          ),
        ];
        checkpoint = {
          history_page: page.nextPageToken || null,
          ...(page.nextPageToken ? {} : { history_id: page.historyId }),
        };
      } catch (e) {
        if (status(e) !== 404) throw e;
        await update({
          history_id: null,
          history_page: null,
          bootstrap_started: false,
          bootstrap_page: null,
          lease_id: null,
          lease_until: null,
        });
        return { synced: 0, resync: true };
      }
    }
    const applicationSenders = (process.env.GMAIL_APPLICATION_SENDERS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const id of ids) {
      // Leave time for an in-flight message to finish before the host deadline.
      // Retain the page cursor; the next pass skips messages already committed.
      if (Date.now() - started > 180000) {
        await update({
          synced_at: new Date().toISOString(),
          last_error: null,
          lease_id: null,
          lease_until: null,
        });
        return { synced, more: true };
      }
      const externalId = `gmail:${connection.mailbox}:${id}`;
      const existing = await db
        .from("hf_activities")
        .select("id")
        .eq("company_id", company)
        .eq("external_id", externalId)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) continue;
      let message: GmailMessage;
      try {
        message = await get<GmailMessage>(
          `messages/${encodeURIComponent(id)}?format=full`,
        );
      } catch (e) {
        if (status(e) === 404) continue;
        throw e;
      }
      if (message.labelIds?.some((l) => ["DRAFT", "SPAM", "TRASH"].includes(l)))
        continue;
      if (message.payload)
        await loadGmailTextParts(
          message.payload,
          async (attachmentId) =>
            (
              await get<{ data: string }>(
                `messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
              )
            ).data,
        );
      const parsed = parseGmailMessage(
        message,
        connection.mailbox,
        applicationSenders,
      );
      const attachments = [];
      for (const file of parsed.attachments) {
        const fileKey = createHash("sha256")
          .update(`${id}:${file.part}`)
          .digest("hex");
        const path = `${company}/${connection.generation}/${fileKey}`;
        if (file.size > 25 * 1024 * 1024) {
          attachments.push({
            name: file.name,
            size: file.size,
            unavailable: "Open in Gmail: attachment exceeds 25 MB.",
          });
          continue;
        }
        const body =
          file.data ??
          (file.attachment_id
            ? (
                await get<{ data: string }>(
                  `messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file.attachment_id)}`,
                )
              ).data
            : null);
        if (body === null) continue;
        const bytes = Buffer.from(body, "base64url");
        const uploaded = await db.storage
          .from(attachmentBucket)
          .upload(path, bytes, { upsert: true, contentType: file.mime_type });
        if (uploaded.error) throw uploaded.error;
        attachments.push({
          path,
          name: file.name,
          size: bytes.length,
          mime_type: file.mime_type,
        });
      }
      const { attachments: _sourceAttachments, ...record } = parsed;
      const result = await db.rpc("hf_gmail_ingest", {
        cid: company,
        connection_generation: connection.generation,
        worker: connection.lease_id,
        payload: { ...record, metadata: { ...record.metadata, attachments } },
      });
      if (result.error) throw result.error;
      synced++;
    }
    await update({
      ...checkpoint,
      synced_at: new Date().toISOString(),
      last_error: null,
      lease_id: null,
      lease_until: null,
    });
    return {
      synced,
      more: !!(checkpoint.bootstrap_page || checkpoint.history_page),
    };
  } catch (e) {
    await update({
      last_error:
        status(e) === 401 ||
        String((e as Error)?.message).includes("invalid_grant")
          ? "Gmail authorization expired. Reconnect Gmail."
          : "Gmail sync failed. Retry sync or reconnect if this continues.",
      lease_id: null,
      lease_until: null,
    });
    throw new Error(
      "Gmail sync failed. Your previous messages are still available.",
    );
  }
}

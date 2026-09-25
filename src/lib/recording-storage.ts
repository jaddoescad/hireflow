import "server-only";
import { Readable } from "node:stream";
import { DeleteObjectsCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { adminDb } from "./supabase/server";
import { googleOAuth } from "./google";

// Any S3-compatible store works (Supabase Storage today). Moving providers only changes these settings
// and copies the objects; the database stores keys, never provider URLs.
function store() {
  const { RECORDING_STORAGE_ENDPOINT: endpoint, RECORDING_STORAGE_REGION: region, RECORDING_STORAGE_BUCKET: bucket,
    RECORDING_STORAGE_ACCESS_KEY_ID: accessKeyId, RECORDING_STORAGE_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { bucket, client: new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }) };
}
export function recordingStorageConfigured() {
  return !!store();
}
export async function recordingPlaybackUrl(key: string) {
  const s3 = store();
  if (!s3) throw new Error("Recording storage is not configured.");
  return getSignedUrl(s3.client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { expiresIn: 4 * 3600 });
}

class CopyError extends Error {}
type Claim = { company_id: string; name: string; interview_id: string; drive_file_id: string; credentials: string };
function driveError(status: number) {
  return new CopyError(
    status === 401 ? "Google authorization expired. Reconnect Google in Settings to save recordings." :
    status === 403 ? "Google Drive denied access. Reconnect Google in Settings and allow access to Meet recordings." :
    status === 404 ? "The recording is no longer in Google Drive." :
    "Could not copy the recording from Google Drive. HireFlow will retry.");
}

// Streams one recording from Drive into storage without buffering the whole video.
async function copy(row: Claim, deadline: number) {
  const s3 = store()!;
  const db = adminDb();
  const { token } = await googleOAuth(row.credentials).getAccessToken();
  const drive = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.drive_file_id)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const abort = AbortSignal.timeout(Math.max(deadline - Date.now(), 1000));
  const meta = await fetch(`${drive}?fields=size,mimeType`, { headers, signal: abort });
  if (!meta.ok) throw driveError(meta.status);
  const { size, mimeType } = await meta.json() as { size?: string; mimeType?: string };
  const media = await fetch(`${drive}?alt=media`, { headers, signal: abort });
  if (!media.ok || !media.body) throw driveError(media.status);
  const key = `${row.company_id}/${row.interview_id}/${row.name.replace(/[^A-Za-z0-9_-]/g, "_")}.mp4`;
  const upload = new Upload({
    client: s3.client, partSize: 16 * 1024 * 1024, queueSize: 4,
    params: { Bucket: s3.bucket, Key: key, Body: Readable.fromWeb(media.body as never), ContentType: mimeType || "video/mp4" },
  });
  abort.addEventListener("abort", () => void upload.abort());
  await upload.done();
  const saved = await db.from("hf_interview_recordings")
    .update({ storage_key: key, storage_size: size ? Number(size) : null, stored_at: new Date().toISOString(), storage_error: null, storage_claim_until: null })
    .eq("company_id", row.company_id).eq("name", row.name).is("storage_key", null).select("name");
  // The interview was deleted while copying, so its object has no owner.
  if (!saved.error && !saved.data.length) await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
  if (saved.error) throw new Error("Could not record the saved copy.");
}

export async function storeRecordings(deadline: number) {
  if (!store()) return { stored: 0, failed: 0, removed: 0 };
  const db = adminDb();
  let stored = 0, failed = 0;
  while (Date.now() < deadline - 60000) {
    const { data, error } = await db.rpc("hf_recording_claim", { max_rows: 1 });
    if (error) throw new Error("Could not load recordings to save.");
    const row = (data as Claim[])[0];
    if (!row) break;
    try { await copy(row, deadline - 10000); stored++; }
    catch (e) {
      failed++;
      await db.from("hf_interview_recordings").update({
        storage_error: e instanceof CopyError ? e.message
          : e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name) ? "Copying took too long. HireFlow will retry."
          : "Could not save the recording. HireFlow will retry.",
        storage_claim_until: null,
      }).eq("company_id", row.company_id).eq("name", row.name);
    }
  }
  return { stored, failed, removed: await removeDeleted() };
}

async function removeDeleted() {
  const s3 = store()!;
  const db = adminDb();
  const { data, error } = await db.from("hf_storage_deletions").select("key").limit(500);
  if (error || !data.length) return 0;
  const keys = data.map(d => d.key as string);
  const result = await s3.client.send(new DeleteObjectsCommand({ Bucket: s3.bucket, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }));
  const failed = new Set((result.Errors || []).map(e => e.Key));
  const removed = keys.filter(k => !failed.has(k));
  if (removed.length) await db.from("hf_storage_deletions").delete().in("key", removed);
  return removed.length;
}

import "server-only";
import { DeleteObjectsCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { adminDb } from "./supabase/server";

// Any S3-compatible store works (Supabase Storage today). Moving providers only changes these settings
// and copies the objects; the database stores keys, never provider URLs.
function store() {
  const { RECORDING_STORAGE_ENDPOINT: endpoint, RECORDING_STORAGE_REGION: region, RECORDING_STORAGE_BUCKET: bucket,
    RECORDING_STORAGE_ACCESS_KEY_ID: accessKeyId, RECORDING_STORAGE_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { bucket, client: new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }) };
}
export async function recordingPlaybackUrl(key: string) {
  const s3 = store();
  if (!s3) throw new Error("Recording storage is not configured.");
  return getSignedUrl(s3.client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { expiresIn: 4 * 3600 });
}

export async function removeDeletedRecordings() {
  const s3 = store();
  if (!s3) return 0;
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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function verifyQuoSignature(
  payload: unknown,
  header: string,
  secret: string,
  now = Date.now(),
) {
  return header.split(",").some((entry) => {
    const [scheme, version, timestamp, digest] = entry.trim().split(";");
    if (scheme !== "hmac" || version !== "1" || !/^\d+$/.test(timestamp || ""))
      return false;
    const time = Number(timestamp);
    if (!Number.isFinite(time) || Math.abs(now - time) > 300000) return false;
    const expected = createHmac("sha256", Buffer.from(secret, "base64"))
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest();
    const actual = Buffer.from(digest || "", "base64");
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  });
}
// Recall signs webhooks Svix-style: base64 HMAC-SHA256 of "id.timestamp.body" with the whsec_ secret.
export function verifyRecallSignature(
  body: string,
  headers: { id: string; timestamp: string; signature: string },
  secret: string,
  now = Date.now(),
) {
  if (!secret.startsWith("whsec_") || !headers.id || !/^\d+$/.test(headers.timestamp)) return false;
  if (Math.abs(now - Number(headers.timestamp) * 1000) > 300000) return false;
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${headers.id}.${headers.timestamp}.${body}`)
    .digest();
  return headers.signature.split(" ").some((entry) => {
    const [version, digest] = entry.split(",");
    const actual = Buffer.from(digest || "", "base64");
    return version === "v1" && expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

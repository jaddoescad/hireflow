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

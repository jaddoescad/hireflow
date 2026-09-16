import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function key() {
  const value = Buffer.from(process.env.GMAIL_TOKEN_KEY || "", "base64");
  if (value.length !== 32)
    throw new Error("Gmail encryption is not configured.");
  return value;
}
export function sealGmail(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function openGmail<T>(value: string): T {
  const data = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

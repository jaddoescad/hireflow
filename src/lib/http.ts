import { NextResponse } from "next/server";
import { z } from "zod";
export function failure(error: unknown, status = 400) {
  return NextResponse.json(
    {
      error:
        error instanceof z.ZodError
          ? error.issues.map((x) => x.message).join(" ")
          : error instanceof Error
            ? error.message
            : "Request failed",
    },
    { status },
  );
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(process.env.APP_URL || request.url).origin)
    throw new Error("Request origin is not allowed.");
}
export async function bodyJson(request: Request, max = 65536) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body is required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("Request is too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

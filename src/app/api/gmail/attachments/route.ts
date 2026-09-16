import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionDb, adminDb } from "@/lib/supabase/server";
import { failure } from "@/lib/http";
import { attachmentBucket } from "@/lib/gmail";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const cid = z.uuid().parse(params.get("company"));
    const activity = z.uuid().parse(params.get("activity"));
    const index = z.coerce
      .number()
      .int()
      .min(0)
      .max(500)
      .parse(params.get("file"));
    const session = await sessionDb();
    const {
      data: { user },
    } = await session.auth.getUser();
    if (!user) return failure(new Error("Sign in to continue."), 401);
    const { data, error } = await session
      .from("hf_activities")
      .select("metadata")
      .eq("company_id", cid)
      .eq("id", activity)
      .eq("kind", "email")
      .maybeSingle();
    if (error || !data)
      return failure(new Error("Attachment access denied."), 403);
    const file = data.metadata.attachments?.[index];
    if (!file?.path || !file.path.startsWith(`${cid}/`))
      return failure(new Error("Attachment unavailable."), 404);
    const download = await adminDb()
      .storage.from(attachmentBucket)
      .download(file.path);
    if (download.error) throw download.error;
    const bytes = await download.data.arrayBuffer();
    const name = String(file.name || "attachment").replace(/[\r\n\\/]/g, "_");
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return failure(new Error("Could not download attachment."), 400);
  }
}

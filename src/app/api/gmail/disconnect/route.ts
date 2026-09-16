import { NextResponse } from "next/server";
import { z } from "zod";
import { gmailAdmin } from "@/lib/gmail";
import { adminDb } from "@/lib/supabase/server";
import { sameOrigin, bodyJson, failure } from "@/lib/http";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await bodyJson(request);
    const cid = z.uuid().parse(body.company_id);
    const user = await gmailAdmin(cid);
    const db = adminDb();
    const result = await db.rpc("hf_gmail_set", {
      actor: user.id,
      cid,
      mailbox_address: null,
      encrypted_credentials: null,
    });
    if (result.error) throw result.error;
    // Remove only this company’s credentials; other companies may share the mailbox.
    return NextResponse.json({ disconnected: true });
  } catch (e) {
    return failure(e);
  }
}

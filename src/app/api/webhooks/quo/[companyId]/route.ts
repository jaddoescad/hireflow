import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/supabase/server";
import { bodyJson, failure } from "@/lib/http";
import { verifyQuoSignature } from "@/lib/crypto";
import { parseQuoEvent } from "@/lib/quo";
export async function POST(
  request: Request,
  context: { params: Promise<{ companyId: string }> },
) {
  try {
    const { companyId } = await context.params;
    if (!z.uuid().safeParse(companyId).success)
      return failure(new Error("Invalid endpoint"), 404);
    const db = adminDb();
    const { data: i, error: lookupError } = await db
      .from("hf_integrations")
      .select("quo_signing_secret,quo_phone_id,quo_phone")
      .eq("company_id", companyId)
      .maybeSingle();
    if (lookupError)
      return failure(new Error("Webhook service unavailable"), 503);
    if (!i?.quo_signing_secret)
      return failure(new Error("Webhook not configured"), 401);
    const body = await bodyJson(request, 262144);
    if (
      !i.quo_signing_secret
        .split(",")
        .some((secret: string) =>
          verifyQuoSignature(
            body,
            request.headers.get("openphone-signature") || "",
            secret.trim(),
          ),
        )
    )
      return failure(new Error("Invalid signature"), 401);
    const payload = parseQuoEvent(body, i.quo_phone_id, i.quo_phone);
    if (!payload) return NextResponse.json({ ignored: true });
    const { data, error } = await db.rpc("hf_ingest", {
      cid: companyId,
      event_kind: "quo",
      payload,
    });
    if (error)
      return failure(new Error("Could not save event. Please retry."), 503);
    return NextResponse.json(data);
  } catch (error) {
    return failure(error);
  }
}

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/supabase/server";
import { hash } from "@/lib/crypto";
import { intakeSchema } from "@/lib/validation";
import { bodyJson, failure } from "@/lib/http";
export async function POST(request: Request) {
  try {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer (hf_[a-f0-9]{64})$/)?.[1];
    if (!token) return failure(new Error("Invalid intake token."), 401);
    const db = adminDb();
    const { data: integration, error: lookupError } = await db
      .from("hf_integrations")
      .select("company_id")
      .eq("intake_key_hash", hash(token))
      .maybeSingle();
    if (lookupError)
      return failure(new Error("Intake service unavailable."), 503);
    if (!integration) return failure(new Error("Invalid intake token."), 401);
    const payload = intakeSchema.parse(await bodyJson(request));
    const { data, error } = await db.rpc("hf_ingest", {
      cid: integration.company_id,
      event_kind: "intake",
      payload,
    });
    if (error)
      return failure(
        new Error("Could not save application. Please retry."),
        503,
      );
    return NextResponse.json(data);
  } catch (error) {
    return failure(error);
  }
}

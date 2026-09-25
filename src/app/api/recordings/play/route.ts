import { NextResponse } from "next/server";
import { z } from "zod";
import { companyMember } from "@/lib/google";
import { recordingPlaybackUrl } from "@/lib/recording-storage";
import { failure } from "@/lib/http";
// Issues a short-lived link to a saved copy after checking current, enabled membership.
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const company = z.uuid().parse(params.get("company"));
    const name = z.string().min(1).max(300).parse(params.get("name"));
    const { db } = await companyMember(company);
    const { data, error } = await db.from("hf_interview_recordings").select("storage_key")
      .eq("company_id", company).eq("name", name).not("storage_key", "is", null).maybeSingle();
    if (error || !data) return failure(new Error("Recording unavailable."), 404);
    return NextResponse.json({ url: await recordingPlaybackUrl(data.storage_key) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return failure(e); }
}

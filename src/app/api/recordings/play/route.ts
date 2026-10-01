import { firefliesPlayback } from "@/lib/fireflies";
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
    const { data, error } = await db.from("hf_interview_recordings").select("storage_key,fireflies_id,transcript,has_video")
      .eq("company_id", company).eq("name", name).maybeSingle();
    if (error || !data) return failure(new Error("Recording unavailable."), 404);
    return NextResponse.json({ url: data.storage_key ? await recordingPlaybackUrl(data.storage_key) : data.fireflies_id && data.has_video ? await firefliesPlayback(company,data.fireflies_id) : null, transcript: data.transcript }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return failure(e); }
}

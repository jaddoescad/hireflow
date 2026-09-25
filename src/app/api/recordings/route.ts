import { NextResponse } from "next/server";
import { z } from "zod";
import { meetMember } from "@/lib/meet";
import { failure } from "@/lib/http";
export async function GET(request:Request) {
  try {
    const company=z.uuid().parse(new URL(request.url).searchParams.get("company"));
    const {db}=await meetMember(company);
    const {data,error}=await db.from("hf_interview_recordings").select("*,interview:hf_interviews(title,candidate_id)")
      .eq("company_id",company).order("starts_at",{ascending:false,nullsFirst:false}).limit(500);
    if(error) throw new Error("Could not load recordings.");
    return NextResponse.json({recordings:data},{headers:{"Cache-Control":"no-store"}});
  } catch(e) { return failure(e); }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { companyMember } from "@/lib/google";
import { failure } from "@/lib/http";
export async function GET(request:Request) {
  try {
    const params=new URL(request.url).searchParams;
    const company=z.uuid().parse(params.get("company"));
    const candidate=params.has("candidate")?z.uuid().parse(params.get("candidate")):null;
    const {db}=await companyMember(company);
    let query=db.from("hf_interview_recordings").select("*,interview:hf_interviews!inner(title,candidate_id)").eq("company_id",company);
    if(candidate) query=query.eq("interview.candidate_id",candidate);
    const {data,error}=await query.order("starts_at",{ascending:false,nullsFirst:false}).limit(500);
    if(error) throw new Error("Could not load recordings.");
    return NextResponse.json({recordings:data},{headers:{"Cache-Control":"no-store"}});
  } catch(e) { return failure(e); }
}

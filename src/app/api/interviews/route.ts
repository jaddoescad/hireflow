import { NextResponse, after } from "next/server";
import { z } from "zod";
import { syncMeet } from "@/lib/meet";
import { companyMember } from "@/lib/google";
import { interviewSchema } from "@/lib/interviews";
import { adminDb } from "@/lib/supabase/server";
import { sameOrigin, bodyJson, failure } from "@/lib/http";
export const maxDuration=240;
export async function GET(request:Request) {
  try {
    const params=new URL(request.url).searchParams;
    const company=z.uuid().parse(params.get("company"));
    const {db}=await companyMember(company);
    const start=z.iso.datetime().parse(params.get("start"));
    const end=z.iso.datetime().parse(params.get("end"));
    if(Date.parse(end)<=Date.parse(start)||Date.parse(end)-Date.parse(start)>62*86400000) throw new Error("Invalid calendar range.");
    const {data:sessions,error}=await db.from("hf_interviews").select("*").eq("company_id",company)
      .gte("starts_at",start).lt("starts_at",end).order("starts_at").limit(1000);
    if(error) throw new Error("Could not load interviews.");
    const recordings=sessions.length ? await db.from("hf_interview_recordings").select("*")
      .eq("company_id",company).in("interview_id",sessions.map(s=>s.id)).order("starts_at") : {data:[],error:null};
    if(recordings.error) throw new Error("Could not load recordings.");
    return NextResponse.json({sessions,recordings:recordings.data},{headers:{"Cache-Control":"no-store"}});
  } catch(e) { return failure(e); }
}
export async function POST(request:Request) {
  try {
    sameOrigin(request);
    const body=await bodyJson(request);
    const company=z.uuid().parse(body.company_id);
    const {user}=await companyMember(company);
    const payload=body.payload?.cancel
      ? z.object({id:z.uuid(),version:z.number().int().positive(),cancel:z.literal(true)}).parse(body.payload)
      : interviewSchema.parse(body.payload);
    const {data:id,error}=await adminDb().rpc("hf_interview_save",{actor:user.id,cid:company,payload});
    if(error?.message==="Candidate already has an upcoming interview")
      return NextResponse.json({error:error.message,duplicate_at:error.details},{status:409});
    if(error) throw new Error(error.message);
    // Wait out a running sync briefly; the saved change stays queued for the scheduled sync either way.
    after(async()=>{
      for(let attempt=0;attempt<12;attempt++) {
        try {if((await syncMeet(company,user.id,id,{budget:60000})).state!=="busy") return;} catch {return;}
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
    });
    return NextResponse.json({id});
  } catch(e) { return failure(e); }
}

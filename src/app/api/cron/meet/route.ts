import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminDb } from "@/lib/supabase/server";
import { syncMeet } from "@/lib/meet";
export const maxDuration=300;
export async function GET(request:Request) {
  const secret=process.env.CRON_SECRET;
  const received=Buffer.from(request.headers.get("authorization")||"");
  const expected=Buffer.from(`Bearer ${secret}`);
  if(!secret||received.length!==expected.length||!timingSafeEqual(received,expected))
    return new NextResponse("Unauthorized",{status:401});
  const {data,error}=await adminDb().from("hf_meet_connections").select("company_id,google:hf_google_connections!inner(credentials)")
    .not("google.credentials","is",null).order("synced_at",{nullsFirst:true}).limit(10);
  if(error) return NextResponse.json({error:"Could not load connections"},{status:500});
  let synced=0,failed=0;
  const started=Date.now();
  for(const row of data) {
    const remaining=270000-(Date.now()-started);
    if(remaining<30000) break;
    try {const result=await syncMeet(row.company_id,null,undefined,{budget:remaining-20000});synced+=result.synced;if(result.error) failed++;}
    catch {failed++;}
  }
  return NextResponse.json({synced,failed});
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { meetAvailable, meetMember, releaseGoogle, syncMeet } from "@/lib/meet";
import { adminDb } from "@/lib/supabase/server";
import { sameOrigin, bodyJson, failure } from "@/lib/http";
export const maxDuration = 240;
export async function GET(request:Request) {
  try {
    const company=z.uuid().parse(new URL(request.url).searchParams.get("company"));
    await meetMember(company);
    const {data,error}=await adminDb().from("hf_meet_connections")
      .select("organizer,credentials,synced_at,last_error,events_subscription,events_expire_at,events_error").eq("company_id",company).maybeSingle();
    if(error) throw new Error("Could not load Google connection.");
    const connected=!!data?.credentials;
    return NextResponse.json({connected,available:meetAvailable(),
      organizer:data?.organizer||null,synced_at:data?.synced_at||null,last_error:connected?data?.last_error||null:null,
      instant_updates:connected&&!!data?.events_subscription&&Date.parse(data.events_expire_at||"")>Date.now(),
      events_error:connected?data?.events_error||null:null},
      {headers:{"Cache-Control":"no-store"}});
  } catch(e) { return failure(e); }
}
export async function POST(request:Request) {
  try {
    sameOrigin(request);
    const body=await bodyJson(request);
    const company=z.uuid().parse(body.company_id);
    const action=z.enum(["sync","disconnect"]).parse(body.action);
    const {user}=await meetMember(company,action==="disconnect");
    if(action==="disconnect") {
      const db=adminDb();
      const {data:previous}=await db.from("hf_meet_connections").select("organizer,credentials,events_subscription").eq("company_id",company).maybeSingle();
      const {error}=await db.rpc("hf_meet_set",{actor:user.id,cid:company,mailbox:"",google_id:null,encrypted_credentials:null});
      if(error) throw new Error(error.message);
      if(previous?.credentials) await releaseGoogle(previous.credentials,previous.organizer,previous.events_subscription).catch(()=>{});
      return NextResponse.json({disconnected:true});
    }
    const sid=body.id ? z.uuid().parse(body.id) : undefined;
    return NextResponse.json(await syncMeet(company,user.id,sid));
  } catch(e) { return failure(e); }
}

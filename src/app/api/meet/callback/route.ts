import { NextResponse, after } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { meetMember, meetOAuth, meetScopes, syncMeet } from "@/lib/meet";
import { openGmail, sealGmail } from "@/lib/gmail-crypto";
import { adminDb } from "@/lib/supabase/server";
export async function GET(request: Request) {
  const destination = new URL("/?view=calendar", process.env.APP_URL);
  const jar = await cookies();
  const saved = jar.get("hf_meet_oauth")?.value;
  jar.delete({name:"hf_meet_oauth",path:"/api/meet"});
  try {
    if (!saved) throw new Error("Expired");
    const ctx = openGmail<{state:string;verifier:string;company:string;organizer:string;actor:string;expires:number}>(saved);
    const params = new URL(request.url).searchParams;
    const state = params.get("state") || "";
    if (ctx.expires < Date.now() || Buffer.byteLength(state)!==Buffer.byteLength(ctx.state) ||
      !timingSafeEqual(Buffer.from(state),Buffer.from(ctx.state))) throw new Error("State mismatch");
    const { user } = await meetMember(ctx.company,true);
    if (user.id!==ctx.actor) throw new Error("Account changed");
    destination.searchParams.set("company",ctx.company);
    const code = params.get("code");
    if(!code) throw new Error("Declined");
    const client = meetOAuth();
    const { tokens } = await client.getToken({code,codeVerifier:ctx.verifier});
    const scopes = tokens.scope?.split(" ") || [];
    if (!tokens.refresh_token || !tokens.id_token || !meetScopes.filter(s=>s.startsWith("https:")).every(s=>scopes.includes(s)))
      throw new Error("Permissions required");
    const ticket = await client.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_CLIENT_ID});
    const profile = ticket.getPayload();
    if(!profile?.email_verified || profile.email?.toLowerCase()!==ctx.organizer) {
      destination.searchParams.set("meet","wrong-account");
      return NextResponse.redirect(destination);
    }
    // Meet recording and automatic artifacts require a Google Workspace organizer.
    if(!profile.hd) {
      destination.searchParams.set("meet","not-workspace");
      return NextResponse.redirect(destination);
    }
    const result = await adminDb().rpc("hf_meet_set",{
      actor:user.id,cid:ctx.company,mailbox:ctx.organizer,google_id:profile.sub,
      encrypted_credentials:sealGmail({refresh_token:tokens.refresh_token}),
    });
    if(result.error) {
      destination.searchParams.set("meet",result.error.message.includes("still active")?"organizer-active":"error");
      return NextResponse.redirect(destination);
    }
    after(async()=>{try {await syncMeet(ctx.company,user.id,undefined,{renewEvents:true});} catch {/* Retried by cron. */}});
    destination.searchParams.set("meet","connected");
  } catch { destination.searchParams.set("meet","error"); }
  return NextResponse.redirect(destination);
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { companyMember, googleAvailable } from "@/lib/google";
import { releaseGoogle, syncMeet } from "@/lib/meet";
import { syncGmail } from "@/lib/gmail";
import { adminDb } from "@/lib/supabase/server";
import { sameOrigin, bodyJson, failure } from "@/lib/http";
export const maxDuration = 240;
// Connection status for any member; credentials never leave the server.
export async function GET(request: Request) {
  try {
    const company = z.uuid().parse(new URL(request.url).searchParams.get("company"));
    await companyMember(company);
    const db = adminDb();
    const [google, meet] = await Promise.all([
      db.from("hf_google_connections").select("account,credentials").eq("company_id", company).maybeSingle(),
      db.from("hf_meet_connections").select("synced_at,last_error,events_subscription,events_expire_at,events_error").eq("company_id", company).maybeSingle(),
    ]);
    if (google.error || meet.error) throw new Error("Could not load Google connection.");
    const connected = !!google.data?.credentials;
    return NextResponse.json({
      connected, available: googleAvailable(), account: connected ? google.data!.account : null,
      synced_at: meet.data?.synced_at || null, last_error: connected ? meet.data?.last_error || null : null,
      instant_updates: connected && !!meet.data?.events_subscription && Date.parse(meet.data.events_expire_at || "") > Date.now(),
      events_error: connected ? meet.data?.events_error || null : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await bodyJson(request);
    const company = z.uuid().parse(body.company_id);
    const action = z.enum(["sync", "sync_email", "disconnect"]).parse(body.action);
    const { user } = await companyMember(company, action !== "sync");
    if (action === "sync") return NextResponse.json(await syncMeet(company, user.id, body.id ? z.uuid().parse(body.id) : undefined));
    if (action === "sync_email") return NextResponse.json(await syncGmail(company, user.id));
    const db = adminDb();
    const [google, meet] = await Promise.all([
      db.from("hf_google_connections").select("account,credentials").eq("company_id", company).maybeSingle(),
      db.from("hf_meet_connections").select("events_subscription").eq("company_id", company).maybeSingle(),
    ]);
    const { error } = await db.rpc("hf_google_set", { actor: user.id, cid: company, address: null, google_id: null, encrypted_credentials: null });
    if (error) throw new Error(error.message);
    if (google.data?.credentials)
      await releaseGoogle(google.data.credentials, google.data.account, meet.data?.events_subscription || null).catch(() => {});
    return NextResponse.json({ disconnected: true });
  } catch (e) { return failure(e); }
}

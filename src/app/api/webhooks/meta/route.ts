import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/supabase/server";
import { openGmail } from "@/lib/gmail-crypto";
import { hash } from "@/lib/crypto";
import { metaEvents, validMetaSignature, type MetaCredentials } from "@/lib/meta";
import { bodyText } from "@/lib/http";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get("hub.verify_token"), challenge = params.get("hub.challenge");
  if (params.get("hub.mode") !== "subscribe" || !token || token.length > 500 || !challenge || !/^\d{1,100}$/.test(challenge))
    return new NextResponse("Invalid verification", { status: 400 });
  const { data, error } = await adminDb().from("hf_meta_connections").select("verify_hash").eq("verify_hash", hash(token)).not("credentials", "is", null).limit(1);
  if (error) return new NextResponse("Retry", { status: 503 });
  if (!data?.[0] || !timingSafeEqual(Buffer.from(data[0].verify_hash), Buffer.from(hash(token))))
    return new NextResponse("Unauthorized", { status: 403 });
  return new NextResponse(challenge, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let raw: string, events: ReturnType<typeof metaEvents>;
  try { raw = await bodyText(request, 1048576); events = metaEvents(JSON.parse(raw)); }
  catch { return new NextResponse("Invalid event", { status: 400 }); }
  const db = adminDb();
  // Authenticate the whole batch before any writes. Company identity comes only from saved Page mappings.
  try {
    const { data, error } = await db.from("hf_meta_connections").select("page_id,credentials").in("page_id", [...new Set(events.map(e => e.page_id))]).not("credentials", "is", null);
    if (error) return new NextResponse("Retry", { status: 503 });
    for (const connection of data || []) {
      const credentials = openGmail<MetaCredentials>(connection.credentials);
      if (!validMetaSignature(raw, request.headers.get("x-hub-signature-256"), credentials.app_secret))
        return new NextResponse("Unauthorized", { status: 401 });
    }
    const pages = new Set(data?.map(c => c.page_id));
    for (const event of events.filter(e => pages.has(e.page_id))) {
      const queued = await db.rpc("hf_meta_enqueue", { page: event.page_id, form_id: event.form_id, lead: event.leadgen_id });
      if (queued.error) return new NextResponse("Retry", { status: 503 });
    }
    return new NextResponse("EVENT_RECEIVED");
  } catch { return new NextResponse("Retry", { status: 503 }); }
}

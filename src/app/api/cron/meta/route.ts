import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminDb } from "@/lib/supabase/server";
import { pollMetaConnection, processMetaLeads } from "@/lib/meta-sync";
export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") || ""), expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new NextResponse("Unauthorized", { status: 401 });
  const db = adminDb();
  const due = await db.from("hf_meta_connections").select("company_id").not("credentials", "is", null)
    .or(`last_polled_at.is.null,last_polled_at.lt.${new Date(Date.now() - 300000).toISOString()}`)
    .order("last_polled_at", { nullsFirst: true }).limit(2);
  if (due.error) return NextResponse.json({ error: "Could not load Meta connections." }, { status: 503 });
  let failed = 0;
  for (const c of due.data) await pollMetaConnection(c.company_id, 45000).catch(() => { failed++; });
  const result = await processMetaLeads(null, 170000);
  return NextResponse.json({ ...result, failed });
}

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminDb } from "@/lib/supabase/server";
import { syncGmail } from "@/lib/gmail";
export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  if (
    !secret ||
    header.length !== expected.length ||
    !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
  )
    return new NextResponse("Unauthorized", { status: 401 });
  const { data, error } = await adminDb()
    .from("hf_gmail_connections")
    .select("company_id")
    .not("credentials", "is", null)
    .order("updated_at")
    .limit(10);
  if (error)
    return NextResponse.json(
      { error: "Could not load connections" },
      { status: 500 },
    );
  let synced = 0,
    failed = 0;
  const started = Date.now();
  for (const row of data) {
    if (Date.now() - started > 230000) break;
    try {
      const result = await syncGmail(row.company_id);
      synced += result.synced;
    } catch {
      failed++;
    }
  }
  return NextResponse.json({ synced, failed });
}

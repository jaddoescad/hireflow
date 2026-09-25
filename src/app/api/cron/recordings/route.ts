import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { storeRecordings } from "@/lib/recording-storage";
export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const received = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || received.length !== expected.length || !timingSafeEqual(received, expected))
    return new NextResponse("Unauthorized", { status: 401 });
  try { return NextResponse.json(await storeRecordings(Date.now() + 280000)); }
  catch { return NextResponse.json({ error: "Could not save recordings" }, { status: 500 }); }
}

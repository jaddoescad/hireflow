import { NextResponse } from "next/server";
import { z } from "zod";
import { companyMember } from "@/lib/google";
import { failure } from "@/lib/http";
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
// Outreach counts for enabled members; the database function re-checks company access.
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const company = z.uuid().parse(params.get("company"));
    const { db } = await companyMember(company);
    const { data, error } = await db.rpc("hf_activity_metrics", {
      cid: company,
      from_day: day.parse(params.get("from") || null),
      to_day: day.parse(params.get("to") || null),
      tz: z.string().min(1).max(100).parse(params.get("tz")),
    });
    if (error) throw new Error("Could not load team activity.");
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failure(e); }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionDb } from "@/lib/supabase/server";
import { failure } from "@/lib/http";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const company = z.uuid().parse(params.get("company"));
    const candidate = z.uuid().parse(params.get("candidate"));
    const page = z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .parse(params.get("page") || 0);
    const notes = params.get("notes") === "1";
    const db = await sessionDb();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return failure(new Error("Sign in to continue."), 401);
    const access = await db
      .from("hf_candidates")
      .select("id")
      .eq("id", candidate)
      .eq("company_id", company)
      .maybeSingle();
    if (access.error) throw access.error;
    if (!access.data)
      return failure(new Error("Candidate access denied."), 403);
    let query = db
      .from("hf_activities")
      .select("*")
      .eq("company_id", company)
      .eq("candidate_id", candidate)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * 50, page * 50 + 50);
    if (notes) query = query.eq("kind", "note");
    else if (params.get("chat") === "1")
      query = query.in("kind", ["sms", "call"]);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json(
      { activities: data.slice(0, 50), has_more: data.length > 50 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return failure(new Error("Could not load candidate history."), 400);
  }
}

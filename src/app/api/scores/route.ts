import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionDb } from "@/lib/supabase/server";
import { failure } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const company = z.uuid().parse(params.get("company"));
    const candidate = z.uuid().parse(params.get("candidate"));
    const db = await sessionDb();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return failure(new Error("Sign in to continue."), 401);
    // Candidate RLS checks current enabled membership, including after revocation.
    const access = await db
      .from("hf_candidates")
      .select("id")
      .eq("company_id", company)
      .eq("id", candidate)
      .maybeSingle();
    if (access.error) throw access.error;
    if (!access.data)
      return failure(new Error("Candidate access denied."), 403);
    const [active, scores] = await Promise.all([
      db
        .from("hf_score_categories")
        .select("*")
        .eq("company_id", company)
        .is("archived_at", null)
        .order("position")
        .order("id"),
      db
        .from("hf_candidate_scores")
        .select("*, category:hf_score_categories(*)")
        .eq("company_id", company)
        .eq("candidate_id", candidate)
        .order("category_id"),
    ]);
    if (active.error) throw active.error;
    if (scores.error) throw scores.error;
    const categories = new Map(
      active.data.map((category) => [category.id, category]),
    );
    const ratings = scores.data.map(({ category, ...score }) => {
      if (category) categories.set(category.id, category);
      return score;
    });
    return NextResponse.json(
      {
        categories: [...categories.values()].sort(
          (a, b) => a.position - b.position,
        ),
        scores: ratings,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return failure(new Error("Could not load interview scores."), 400);
  }
}

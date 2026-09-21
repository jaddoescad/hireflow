import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candidate } from "./types";
export async function allCandidates(db: SupabaseClient, company: string) {
  const first = await db
    .from("hf_candidates_with_scores")
    .select("*", { count: "exact" })
    .eq("company_id", company)
    .order("id")
    .range(0, 999);
  if (first.error) return first;
  const rows: Candidate[] = first.data;
  const total = first.count || 0;
  // Bounded concurrency avoids one request per row and respects Data API row caps.
  for (let start = 1000; start < total; start += 4000) {
    const results = await Promise.all(
      Array.from(
        { length: Math.min(4, Math.ceil((total - start) / 1000)) },
        (_, i) =>
          db
            .from("hf_candidates_with_scores")
            .select("*")
            .eq("company_id", company)
            .order("id")
            .range(start + i * 1000, start + (i + 1) * 1000 - 1),
      ),
    );
    for (const r of results) {
      if (r.error) return r;
      rows.push(...r.data);
    }
  }
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { data: rows, error: null };
}

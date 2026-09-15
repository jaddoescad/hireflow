import { NextResponse } from "next/server";
import { sessionDb, adminDb } from "@/lib/supabase/server";
import { failure } from "@/lib/http";
import { z } from "zod";
import { allCandidates } from "@/lib/candidates";
export async function GET(request: Request) {
  try {
    const db = await sessionDb();
    const {
      data: { user },
      error,
    } = await db.auth.getUser();
    if (error || !user) return failure(new Error("Sign in to continue."), 401);
    const companies = await db
      .from("hf_companies")
      .select("*")
      .order("created_at");
    if (companies.error) throw companies.error;
    const cid = new URL(request.url).searchParams.get("company");
    const base = {
      companies: companies.data,
      user: { id: user.id, email: user.email },
      company: null,
      membership: null,
      members: [],
      stages: [],
      candidates: [],
      activities: [],
      invitations: [],
      integration: null,
    };
    if (!cid)
      return NextResponse.json(base, {
        headers: { "Cache-Control": "no-store" },
      });
    if (!z.uuid().safeParse(cid).success)
      return failure(new Error("Invalid company"), 400);
    const company = companies.data.find((c) => c.id === cid);
    if (!company) return failure(new Error("Company access denied."), 403);
    const results = await Promise.all([
      db.from("hf_members").select("*").eq("company_id", cid),
      db.from("hf_stages").select("*").eq("company_id", cid).order("position"),
      allCandidates(db, cid),
      db
        .from("hf_activities")
        .select("*")
        .eq("company_id", cid)
        .order("occurred_at", { ascending: false })
        .limit(1000),
    ]);
    for (const result of results) if (result.error) throw result.error;
    const [members, stages, candidates, activities] = results.map(
      (r) => r.data!,
    );
    const membership = members.find((m) => m.user_id === user.id && m.enabled);
    if (!membership) return failure(new Error("Company access denied."), 403);
    let invitations: unknown[] = [];
    let integration = null;
    if (membership.role === "admin") {
      const admin = adminDb();
      const [inv, settings] = await Promise.all([
        admin
          .from("hf_invitations")
          .select("id,email,role,expires_at,accepted_at,revoked_at,created_at")
          .eq("company_id", cid)
          .order("created_at", { ascending: false }),
        admin
          .from("hf_integrations")
          .select("*")
          .eq("company_id", cid)
          .single(),
      ]);
      if (inv.error) throw inv.error;
      if (settings.error) throw settings.error;
      invitations = inv.data;
      const s = settings.data;
      integration = {
        intake_configured: !!s.intake_key_hash,
        quo_configured: !!(
          s.quo_api_key &&
          s.quo_phone_id &&
          s.quo_signing_secret
        ),
        quo_phone: s.quo_phone,
        quo_phone_id: s.quo_phone_id,
        last_intake_at: s.last_intake_at,
        last_quo_at: s.last_quo_at,
      };
    }
    return NextResponse.json(
      {
        ...base,
        company,
        membership,
        members,
        stages,
        candidates,
        activities,
        invitations,
        integration,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(
      error instanceof Error
        ? error
        : new Error("Could not load the workspace."),
      500,
    );
  }
}

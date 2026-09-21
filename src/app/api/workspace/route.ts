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
      score_categories: [],
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
      db
        .from("hf_score_categories")
        .select("*")
        .eq("company_id", cid)
        .is("archived_at", null)
        .order("position")
        .order("id"),
    ]);
    for (const result of results) if (result.error) throw result.error;
    const [members, stages, candidates, activities, score_categories] =
      results.map((r) => r.data!);
    const membership = members.find((m) => m.user_id === user.id && m.enabled);
    if (!membership) return failure(new Error("Company access denied."), 403);
    let invitations: unknown[] = [];
    let integration = null;
    if (membership.role === "admin") {
      const admin = adminDb();
      const [inv, settings, gmail] = await Promise.all([
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
        admin
          .from("hf_gmail_connections")
          .select("mailbox,credentials,synced_at,last_error")
          .eq("company_id", cid)
          .maybeSingle(),
      ]);
      if (inv.error) throw inv.error;
      if (settings.error) throw settings.error;
      if (gmail.error) throw gmail.error;
      invitations = inv.data;
      const s = settings.data;
      integration = {
        gmail_available: !!(
          process.env.GOOGLE_CLIENT_ID &&
          process.env.GOOGLE_CLIENT_SECRET &&
          process.env.GMAIL_TOKEN_KEY
        ),
        gmail_connected: !!gmail.data?.credentials,
        gmail_mailbox: gmail.data?.mailbox || null,
        gmail_synced_at: gmail.data?.synced_at || null,
        gmail_error: gmail.data?.last_error || null,
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
        score_categories,
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

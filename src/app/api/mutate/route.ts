import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { sessionDb, adminDb } from "@/lib/supabase/server";
import { failure, sameOrigin, bodyJson } from "@/lib/http";
import { actions } from "@/lib/validation";
import { hash } from "@/lib/crypto";
import { sendInvitation } from "@/lib/mail";
import { z } from "zod";
import { syncQuo } from "@/lib/quo-sync";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const input = await bodyJson(request);
    const action = input.action as keyof typeof actions;
    if (!Object.hasOwn(actions, action)) throw new Error("Unknown action");
    const parsed = actions[action].parse(input.payload);
    let payload: Record<string, unknown> = { ...parsed };
    const cid = input.company_id ? z.uuid().parse(input.company_id) : null;
    const session = await sessionDb();
    const {
      data: { user },
    } = await session.auth.getUser();
    if (!user) return failure(new Error("Sign in to continue."), 401);
    if (action === "quo_sync") {
      if (!cid) throw new Error("Company required");
      return NextResponse.json(
        await syncQuo(cid, String(payload.candidate_id)),
      );
    }
    const db = adminDb();
    let inviteToken: string | undefined;
    let intakeKey: string | undefined;
    if (action === "invite") {
      inviteToken = randomBytes(32).toString("hex");
      payload.token_hash = hash(inviteToken);
    }
    if (action === "accept_invitation") {
      payload = { token_hash: hash(String(payload.token)) };
    }
    if (action === "integration") {
      if (payload.rotate_intake) {
        intakeKey = `hf_${randomBytes(32).toString("hex")}`;
        payload.intake_key_hash = hash(intakeKey);
      }
      delete payload.rotate_intake;
      for (const key of ["quo_api_key", "quo_signing_secret"])
        if (payload[key] === "") delete payload[key];
    }
    const { data, error } = await db.rpc("hf_mutate", {
      actor: user.id,
      cid,
      action,
      payload,
    });
    if (error) throw new Error(error.message);
    let invitation_url;
    let email_sent = false;
    let email_error;
    if (inviteToken) {
      invitation_url = `${new URL(process.env.APP_URL || request.url).origin}/?invite=${inviteToken}`;
      const { data: company } = await db
        .from("hf_companies")
        .select("name")
        .eq("id", cid)
        .single();
      try {
        email_sent = await sendInvitation(
          String(payload.email),
          company?.name || "your company",
          invitation_url,
        );
      } catch {
        email_error =
          "Invitation saved, but email delivery failed. Copy the invitation link or try again after checking SMTP settings.";
      }
    }
    return NextResponse.json({
      ...data,
      invitation_url,
      email_sent,
      email_error,
      intake_key: intakeKey,
    });
  } catch (error) {
    return failure(error);
  }
}

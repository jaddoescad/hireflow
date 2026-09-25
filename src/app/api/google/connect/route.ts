import { NextResponse } from "next/server";
import { CodeChallengeMethod } from "google-auth-library";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { companyMember, googleOAuth, googleScopes } from "@/lib/google";
import { sealGmail } from "@/lib/gmail-crypto";
import { sameOrigin, failure, bodyJson } from "@/lib/http";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const company = z.uuid().parse((await bodyJson(request)).company_id);
    const { user } = await companyMember(company, true);
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    (await cookies()).set("hf_google_oauth", sealGmail({ state, verifier, company, actor: user.id, expires: Date.now() + 600000 }),
      { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/google", maxAge: 600 });
    const url = googleOAuth().generateAuthUrl({
      access_type: "offline", prompt: "consent select_account", scope: googleScopes, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failure(e); }
}

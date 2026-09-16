import { NextResponse } from "next/server";
import { CodeChallengeMethod } from "google-auth-library";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { gmailAdmin, gmailOAuth, gmailScope } from "@/lib/gmail";
import { sealGmail } from "@/lib/gmail-crypto";
import { sameOrigin, failure, bodyJson } from "@/lib/http";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { company_id } = await bodyJson(request);
    const company = z.uuid().parse(company_id);
    const user = await gmailAdmin(company);
    const client = gmailOAuth();
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    const jar = await cookies();
    jar.set(
      "hf_gmail_oauth",
      sealGmail({
        state,
        verifier,
        company,
        actor: user.id,
        expires: Date.now() + 10 * 60 * 1000,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/api/gmail",
        maxAge: 600,
      },
    );
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: [gmailScope],
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return NextResponse.json(
      { url },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}

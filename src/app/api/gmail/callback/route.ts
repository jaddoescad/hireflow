import { NextResponse, after } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { gmailAdmin, gmailOAuth, gmailScope, syncGmail } from "@/lib/gmail";
import { openGmail, sealGmail } from "@/lib/gmail-crypto";
import { adminDb } from "@/lib/supabase/server";
export const maxDuration = 300;
export async function GET(request: Request) {
  const destination = new URL("/", process.env.APP_URL);
  const jar = await cookies();
  const saved = jar.get("hf_gmail_oauth")?.value;
  jar.delete({ name: "hf_gmail_oauth", path: "/api/gmail" });
  try {
    if (!saved) throw new Error("Connection expired");
    const ctx = openGmail<{
      state: string;
      verifier: string;
      company: string;
      actor: string;
      expires: number;
    }>(saved);
    const params = new URL(request.url).searchParams;
    const state = params.get("state") || "";
    if (
      ctx.expires < Date.now() ||
      state.length !== ctx.state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(ctx.state))
    )
      throw new Error("Invalid state");
    const user = await gmailAdmin(ctx.company);
    if (user.id !== ctx.actor) throw new Error("Account changed");
    destination.searchParams.set("company", ctx.company);
    const code = params.get("code");
    if (!code) throw new Error("Authorization declined");
    const client = gmailOAuth();
    const { tokens } = await client.getToken({
      code,
      codeVerifier: ctx.verifier,
    });
    if (!tokens.refresh_token || !tokens.scope?.split(" ").includes(gmailScope))
      throw new Error("Read permission required");
    client.setCredentials(tokens);
    const { data: profile } = await client.request<{ emailAddress: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    const db = adminDb();
    const result = await db.rpc("hf_gmail_set", {
      actor: user.id,
      cid: ctx.company,
      mailbox_address: profile.emailAddress.toLowerCase(),
      encrypted_credentials: sealGmail({ refresh_token: tokens.refresh_token }),
    });
    if (result.error) throw result.error;
    destination.searchParams.set("gmail", "connected");
    after(async () => {
      try {
        await syncGmail(ctx.company);
      } catch {
        /* Sync status is stored without secrets. */
      }
    });
  } catch {
    destination.searchParams.set("gmail", "error");
  }
  return NextResponse.redirect(destination);
}

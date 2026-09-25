import { NextResponse, after } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { companyMember, googleOAuth, googleScopes } from "@/lib/google";
import { openGmail, sealGmail } from "@/lib/gmail-crypto";
import { syncGmail } from "@/lib/gmail";
import { syncMeet } from "@/lib/meet";
import { adminDb } from "@/lib/supabase/server";
export const maxDuration = 300;
export async function GET(request: Request) {
  const destination = new URL("/?view=integrations", process.env.APP_URL);
  const jar = await cookies();
  const saved = jar.get("hf_google_oauth")?.value;
  jar.delete({ name: "hf_google_oauth", path: "/api/google" });
  try {
    if (!saved) throw new Error("Expired");
    const ctx = openGmail<{ state: string; verifier: string; company: string; view: string; actor: string; expires: number }>(saved);
    destination.searchParams.set("view", ctx.view === "calendar" ? "calendar" : "integrations");
    const params = new URL(request.url).searchParams;
    const state = params.get("state") || "";
    if (ctx.expires < Date.now() || Buffer.byteLength(state) !== Buffer.byteLength(ctx.state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(ctx.state))) throw new Error("State mismatch");
    const { user } = await companyMember(ctx.company, true);
    if (user.id !== ctx.actor) throw new Error("Account changed");
    destination.searchParams.set("company", ctx.company);
    const code = params.get("code");
    if (!code) throw new Error("Declined");
    const client = googleOAuth();
    const { tokens } = await client.getToken({ code, codeVerifier: ctx.verifier });
    const granted = tokens.scope?.split(" ") || [];
    if (!tokens.refresh_token || !tokens.id_token || !googleScopes.filter(s => s.startsWith("https:")).every(s => granted.includes(s))) {
      destination.searchParams.set("google", "permissions");
      return NextResponse.redirect(destination);
    }
    const profile = (await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID })).getPayload();
    if (!profile?.email_verified || !profile.email) throw new Error("Unverified account");
    // Meet recording and automatic artifacts require a Google Workspace account.
    if (!profile.hd) {
      destination.searchParams.set("google", "not-workspace");
      return NextResponse.redirect(destination);
    }
    const result = await adminDb().rpc("hf_google_set", {
      actor: user.id, cid: ctx.company, address: profile.email, google_id: profile.sub,
      encrypted_credentials: sealGmail({ refresh_token: tokens.refresh_token }),
    });
    if (result.error) throw result.error;
    after(async () => {
      await Promise.allSettled([syncGmail(ctx.company), syncMeet(ctx.company, user.id, undefined, { renewEvents: true })]);
    });
    destination.searchParams.set("google", "connected");
  } catch { destination.searchParams.set("google", "error"); }
  return NextResponse.redirect(destination);
}

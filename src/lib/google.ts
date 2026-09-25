import "server-only";
import { OAuth2Client } from "google-auth-library";
import { sessionDb } from "./supabase/server";
import { openGmail } from "./gmail-crypto";

// One grant per company covers email import, interview scheduling and recording copies.
export const googleScopes = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/drive.meet.readonly",
];
export function googleAvailable() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GMAIL_TOKEN_KEY);
}
export function googleOAuth(credentials?: string) {
  if (!googleAvailable()) throw new Error("Google is not configured on this server.");
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    `${new URL(process.env.APP_URL!).origin}/api/google/callback`);
  if (credentials) client.setCredentials(openGmail<{ refresh_token: string }>(credentials));
  return client;
}
export async function companyMember(company: string, adminOnly = false) {
  const db = await sessionDb();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error("Sign in to continue.");
  const { data, error } = await db.from("hf_members").select("enabled,role")
    .eq("company_id", company).eq("user_id", user.id).maybeSingle();
  if (error || !data?.enabled || (adminOnly && data.role !== "admin"))
    throw new Error(adminOnly ? "Admin access required." : "Company access denied.");
  return { db, user };
}

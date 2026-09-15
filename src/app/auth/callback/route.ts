import { NextResponse } from "next/server";
import { sessionDb } from "@/lib/supabase/server";
import { authDestination } from "@/lib/auth-navigation";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const destination = authDestination(
    url.origin,
    url.searchParams.get("invite"),
  );
  if (code) {
    const db = await sessionDb();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(destination);
  }
  destination.searchParams.set("auth_error", "1");
  return NextResponse.redirect(destination);
}

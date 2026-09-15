import { NextResponse } from "next/server";
import { sessionDb } from "@/lib/supabase/server";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const db = await sessionDb();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.redirect(new URL("/?auth_error=1", request.url));
}

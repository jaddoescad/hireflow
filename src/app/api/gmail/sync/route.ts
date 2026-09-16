import { NextResponse } from "next/server";
import { z } from "zod";
import { gmailAdmin, syncGmail } from "@/lib/gmail";
import { sameOrigin, bodyJson, failure } from "@/lib/http";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await bodyJson(request);
    const cid = z.uuid().parse(body.company_id);
    const user = await gmailAdmin(cid);
    return NextResponse.json(await syncGmail(cid, user.id));
  } catch (e) {
    return failure(e);
  }
}

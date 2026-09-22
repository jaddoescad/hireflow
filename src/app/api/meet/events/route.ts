import { NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { handleMeetEvent } from "@/lib/meet";
import { bodyJson } from "@/lib/http";
export const maxDuration=60;
const verifier=new OAuth2Client();
const pushSchema=z.object({message:z.object({
  data:z.string().max(20000).optional(),
  attributes:z.record(z.string(),z.string()).default({}),
})});
// Authenticated Pub/Sub push from the Workspace Events subscription topic.
export async function POST(request:Request) {
  const account=process.env.MEET_EVENTS_PUSH_ACCOUNT;
  const token=(request.headers.get("authorization")||"").match(/^Bearer (.+)$/)?.[1];
  if(!account||!token) return new NextResponse("Unauthorized",{status:401});
  try {
    const ticket=await verifier.verifyIdToken({idToken:token,audience:`${new URL(process.env.APP_URL!).origin}/api/meet/events`});
    const claims=ticket.getPayload();
    if(!claims?.email_verified||claims.email!==account) throw new Error("Unexpected sender");
  } catch { return new NextResponse("Unauthorized",{status:401}); }
  try {
    const {message}=pushSchema.parse(await bodyJson(request,32768));
    const subscription=(message.attributes["ce-source"]||"").replace("//workspaceevents.googleapis.com/","");
    const type=message.attributes["ce-type"]||"";
    if(!/^subscriptions\/[\w-]+$/.test(subscription)) return new NextResponse(null,{status:204});
    const data=message.data?JSON.parse(Buffer.from(message.data,"base64").toString("utf8")):{};
    if(await handleMeetEvent(subscription,type,data)) return new NextResponse("Busy",{status:503});
  } catch { /* Scheduled sync reconciles anything missed. */ }
  return new NextResponse(null,{status:204});
}

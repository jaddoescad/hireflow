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
  let subscription: string;
  let type: string;
  let data: { conferenceRecord?: { name?: string } };
  try {
    const {message}=pushSchema.parse(await bodyJson(request,32768));
    subscription=(message.attributes["ce-source"]||"").replace("//workspaceevents.googleapis.com/","");
    type=message.attributes["ce-type"]||"";
    if(!/^subscriptions\/[\w-]+$/.test(subscription)) return new NextResponse(null,{status:204});
    data=z.object({conferenceRecord:z.object({name:z.string().optional()}).optional()})
      .parse(message.data?JSON.parse(Buffer.from(message.data,"base64").toString("utf8")):{});
  } catch { return new NextResponse("Invalid event",{status:400}); }
  try {
    if(await handleMeetEvent(subscription,type,data)) return new NextResponse("Busy",{status:503});
  } catch {
    // A successful acknowledgement would permanently drop a transient Google/database failure.
    // Do not log the payload or provider error, which can contain private meeting details.
    return new NextResponse("Retry",{status:503});
  }
  return new NextResponse(null,{status:204});
}

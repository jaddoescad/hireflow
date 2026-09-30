import { NextResponse, after } from "next/server";
import { z } from "zod";
import { verifyRecallSignature } from "@/lib/crypto";
import { applyRecorderStatus } from "@/lib/recall";
import { storeRecordings } from "@/lib/recording-storage";
export const maxDuration = 300;
const eventSchema = z.object({
  event: z.string().startsWith("bot."),
  data: z.object({
    data: z.object({ code: z.string(), sub_code: z.string().nullish(), updated_at: z.iso.datetime({ offset: true }) }),
    bot: z.object({ id: z.string().min(1).max(100), metadata: z.object({ company_id: z.uuid() }).loose() }),
  }),
});
// Recall bot status webhooks. Unrelated or malformed events are acknowledged so Recall does not retry them.
export async function POST(request: Request) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  const body = await request.text();
  const header = (name: string) => request.headers.get(`webhook-${name}`) || request.headers.get(`svix-${name}`) || "";
  if (!secret || body.length > 65536 || !verifyRecallSignature(body, { id: header("id"), timestamp: header("timestamp"), signature: header("signature") }, secret))
    return new NextResponse("Unauthorized", { status: 401 });
  let parsed;
  try { parsed = eventSchema.safeParse(JSON.parse(body)); } catch { return new NextResponse(null, { status: 204 }); }
  if (!parsed.success) return new NextResponse(null, { status: 204 });
  const { data: { data: status, bot } } = parsed.data;
  try { await applyRecorderStatus(bot.metadata.company_id, bot.id, status.code, status.sub_code, status.updated_at); }
  catch { return new NextResponse("Retry", { status: 503 }); }
  // Save the video right away instead of waiting for the scheduled job.
  if (status.code === "done") after(() => storeRecordings(Date.now() + 280000).catch(() => {}));
  return new NextResponse(null, { status: 204 });
}

import "server-only";
import { sessionDb, adminDb } from "./supabase/server";
import { parseQuoEvent } from "./quo";
export async function syncQuo(cid: string, candidateId: string) {
  const session = await sessionDb();
  const { data: c, error } = await session
    .from("hf_candidates")
    .select("id,phone")
    .eq("id", candidateId)
    .eq("company_id", cid)
    .single();
  if (error || !c?.phone)
    throw new Error("An accessible candidate with a phone number is required.");
  const db = adminDb();
  const { data: i } = await db
    .from("hf_integrations")
    .select("quo_api_key,quo_phone_id,quo_phone")
    .eq("company_id", cid)
    .single();
  if (!i?.quo_api_key || !i.quo_phone_id || !i.quo_phone)
    throw new Error("Ask an admin to connect Quo in Integrations.");
  let count = 0;
  for (const kind of ["messages", "calls"]) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`https://api.quo.com/v1/${kind}`);
      url.searchParams.set("phoneNumberId", i.quo_phone_id);
      url.searchParams.set("participants", c.phone);
      url.searchParams.set("maxResults", "100");
      if (cursor) url.searchParams.set("pageToken", cursor);
      const response = await fetch(url, {
        headers: { Authorization: i.quo_api_key },
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          `Quo returned ${response.status}. Check the connection and try again.`,
        );
      const body = await response.json();
      for (const object of body.data || []) {
        const payload = parseQuoEvent(
          {
            id: object.id,
            type: kind === "messages" ? "message.received" : "call.completed",
            data: { object },
          },
          i.quo_phone_id,
          i.quo_phone,
        );
        if (!payload) continue;
        const { error } = await db.rpc("hf_ingest", {
          cid,
          event_kind: "quo",
          payload,
        });
        if (error) throw new Error("Could not save Quo history");
        count++;
      }
      cursor = body.nextPageToken;
      if (!cursor) break;
      if (page === 19)
        throw new Error(
          "History exceeds the sync limit. Recent records were saved; contact your administrator to import older history.",
        );
    }
  }
  return { synced: count };
}

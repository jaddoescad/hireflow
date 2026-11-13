import "server-only";
import { z } from "zod";
import { metaId, metaLeadSchema } from "./meta";

// A pinned Graph version keeps provider changes out of routine deployments.
const graph = "https://graph.facebook.com/v25.0";
export async function metaGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${graph}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Meta returned ${response.status}. Check the Page connection and lead access.`);
  return response.json();
}
export async function checkMetaConnection(app: string, page: string, secret: string, token: string) {
  metaId.parse(app); metaId.parse(page);
  const debug = await metaGet<{ data: { is_valid: boolean; app_id: string; scopes?: string[] } }>("debug_token", `${app}|${secret}`, { input_token: token });
  if (!debug.data.is_valid || debug.data.app_id !== app || !["leads_retrieval", "pages_manage_metadata"].every(scope => debug.data.scopes?.includes(scope)))
    throw new Error("Use a valid token from this Meta app with leads_retrieval and pages_manage_metadata access.");
  const result = z.object({ id: metaId, name: z.string().min(1) }).parse(await metaGet(page, token, { fields: "id,name" }));
  if (result.id !== page) throw new Error("Page ID does not match this token.");
  // Test the leads surface, rather than accepting a token that can only read a Page name.
  await listMetaForms(page, token);
  return result;
}
export async function listMetaForms(page: string, token: string) {
  const forms: { id: string; name: string }[] = [];
  let after: string | undefined;
  for (let count = 0; count < 20; count++) {
    const body = await metaGet<{ data: unknown[]; paging?: { next?: string; cursors?: { after?: string } } }>(`${metaId.parse(page)}/leadgen_forms`, token,
      { fields: "id,name", limit: "100", ...(after ? { after } : {}) });
    forms.push(...z.array(z.object({ id: metaId, name: z.string().max(300) })).parse(body.data));
    if (!body.paging?.next) return forms;
    after = body.paging.cursors?.after;
    if (!after) throw new Error("Could not continue the Meta forms list.");
  }
  throw new Error("Too many Meta forms. Narrow the connected Page.");
}
export async function getMetaLead(id: string, token: string) {
  return metaLeadSchema.parse(await metaGet(metaId.parse(id), token, { fields: "id,form_id,created_time,ad_id,field_data,custom_disclaimer_responses" }));
}

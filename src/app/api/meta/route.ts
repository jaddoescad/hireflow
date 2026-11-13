import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { companyMember } from "@/lib/google";
import { adminDb } from "@/lib/supabase/server";
import { sealGmail, openGmail } from "@/lib/gmail-crypto";
import { hash } from "@/lib/crypto";
import { bodyJson, sameOrigin, failure } from "@/lib/http";
import { metaId, metaSettingsSchema, type MetaCredentials } from "@/lib/meta";
import { checkMetaConnection, listMetaForms, metaGet } from "@/lib/meta-api";
import { pollMetaConnection, processMetaLeads } from "@/lib/meta-sync";

export const maxDuration = 120;
export async function GET(request: Request) {
  try {
    const company = z.uuid().parse(new URL(request.url).searchParams.get("company"));
    await companyMember(company, true);
    const db = adminDb();
    const [connection, jobs] = await Promise.all([
      db.from("hf_meta_connections").select("*").eq("company_id", company).maybeSingle(),
      db.from("hf_meta_leads").select("lead_id,form_id,candidate_id,state,email_state,sms_state,email_receipt,sms_receipt,last_error,created_at")
        .eq("company_id", company).order("created_at", { ascending: false }).limit(30),
    ]);
    if (connection.error || jobs.error) throw new Error("Could not load Facebook connection.");
    const c = connection.data;
    return NextResponse.json({
      connected: !!c?.credentials, page_id: c?.page_id, page_name: c?.page_name, app_id: c?.app_id,
      active: c?.active || false, notify_after: c?.notify_after, settings: c?.settings,
      last_received_at: c?.last_received_at, last_polled_at: c?.last_polled_at, last_error: c?.last_error,
      callback_url: `${new URL(process.env.APP_URL!).origin}/api/webhooks/meta`,
      verify_token: c?.credentials ? openGmail<MetaCredentials>(c.credentials).verify_token : null,
      jobs: jobs.data,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await bodyJson(request, 131072);
    const company = z.uuid().parse(body.company_id);
    const action = z.enum(["connect", "forms", "settings", "activate", "pause", "disconnect", "sync", "retry"]).parse(body.action);
    const { user } = await companyMember(company, true);
    const db = adminDb();
    if (action === "connect") {
      const input = z.object({ app_id: metaId, page_id: metaId,
        app_secret: z.string().trim().regex(/^[a-fA-F0-9]{32}$/), page_token: z.string().trim().min(20).max(4000) }).parse(body);
      const page = await checkMetaConnection(input.app_id, input.page_id, input.app_secret, input.page_token);
      const credentials: MetaCredentials = { app_secret: input.app_secret, page_token: input.page_token, verify_token: randomBytes(32).toString("hex") };
      const saved = await db.rpc("hf_meta_set", { actor: user.id, cid: company, operation: "connect", payload: {
        page_id: page.id, page_name: page.name, app_id: input.app_id, credentials: sealGmail(credentials), verify_hash: hash(credentials.verify_token),
      } });
      if (saved.error) throw new Error("Could not save the connection. Check admin access and whether this Page belongs to another company.");
      return NextResponse.json({ connected: true });
    }
    const connection = await db.from("hf_meta_connections").select("*").eq("company_id", company).single();
    if (connection.error || !connection.data?.credentials) throw new Error("Connect Facebook first.");
    const c = connection.data, credentials = openGmail<MetaCredentials>(c.credentials);
    if (action === "forms") return NextResponse.json({ forms: await listMetaForms(c.page_id, credentials.page_token) });
    if (action === "sync") {
      await pollMetaConnection(company, 45000);
      return NextResponse.json(await processMetaLeads(company, 65000));
    }
    let payload: Record<string, unknown> = {};
    if (action === "settings") {
      const settings = metaSettingsSchema.parse(body.settings);
      const available = await listMetaForms(c.page_id, credentials.page_token);
      for (const form of settings.forms) {
        const original = available.find(f => f.id === form.id);
        if (!original) throw new Error("Select a form from this Facebook Page.");
        form.name = original.name;
      }
      payload = settings;
    }
    if (action === "activate") {
      const settings = metaSettingsSchema.parse(c.settings);
      if (settings.notification_email && (!process.env.SMTP_HOST || !process.env.SMTP_FROM)) throw new Error("Configure hiring notification email first.");
      if (settings.forms.some(f => f.sms)) {
        const quo = await db.from("hf_integrations").select("quo_api_key,quo_phone,quo_phone_id").eq("company_id", company).single();
        if (quo.error || !quo.data?.quo_api_key || !quo.data.quo_phone || !quo.data.quo_phone_id) throw new Error("Connect Quo first.");
      }
      // Activation only checks subscriptions. It never overwrites another app's callback or Page fields.
      const [app, page] = await Promise.all([
        metaGet<{ data: { object: string; callback_url: string; fields: { name: string }[]; active: boolean }[] }>(`${c.app_id}/subscriptions`, `${c.app_id}|${credentials.app_secret}`),
        metaGet<{ data: { id: string; subscribed_fields?: string[] }[] }>(`${c.page_id}/subscribed_apps`, credentials.page_token),
      ]);
      const callback = `${new URL(process.env.APP_URL!).origin}/api/webhooks/meta`;
      if (!app.data.some(s => s.object === "page" && s.active && s.callback_url === callback && s.fields.some(f => f.name === "leadgen")) ||
          !page.data.some(p => p.id === c.app_id && p.subscribed_fields?.includes("leadgen")))
        throw new Error("Finish the Meta webhook setup and subscribe this Page to leadgen before enabling delivery.");
    }
    const saved = await db.rpc("hf_meta_set", { actor: user.id, cid: company, operation: action, payload });
    if (saved.error) throw new Error("Could not update Facebook settings. Check your admin access.");
    return NextResponse.json({ saved: true });
  } catch (error) { return failure(error); }
}

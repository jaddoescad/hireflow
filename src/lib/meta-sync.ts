import "server-only";
import { adminDb } from "./supabase/server";
import { openGmail } from "./gmail-crypto";
import { applicationEmail, metaApplication, metaId, type MetaCredentials, type MetaForm, type MetaSettings } from "./meta";
import { getMetaLead, metaGet } from "./meta-api";
import { sendApplicationNotification } from "./mail";

type Job = {
  company_id: string; page_id: string; lead_id: string; form_id: string;
  form: MetaForm; settings: MetaSettings; lease_id: string;
  application: ReturnType<typeof metaApplication> | null;
  email_state: string; sms_state: string;
};
export async function processMetaLeads(company: string | null = null, budget = 45000) {
  const db = adminDb(), end = Date.now() + budget;
  let processed = 0;
  while (Date.now() < end - 20000) {
    const claimed = await db.rpc("hf_meta_claim", { cid: company });
    if (claimed.error) throw new Error("Could not claim Meta applications.");
    const job = claimed.data?.[0] as Job | undefined;
    if (!job) break;
    const step = async (operation: string, payload: Record<string, unknown> = {}) => {
      const result = await db.rpc("hf_meta_step", { cid: job.company_id, lead: job.lead_id, worker: job.lease_id, operation, payload });
      if (result.error || !result.data) throw new Error("Meta processing lease or company access changed.");
      return result.data as Job;
    };
    let problem: string | undefined;
    try {
      const connection = await db.from("hf_meta_connections").select("credentials,active,connected_by").eq("company_id", job.company_id).eq("page_id", job.page_id).single();
      if (connection.error || !connection.data?.credentials) throw new Error("Meta connection is unavailable.");
      const member = await db.from("hf_members").select("enabled,role").eq("company_id", job.company_id).eq("user_id", connection.data.connected_by).single();
      if (!member.data?.enabled || member.data.role !== "admin") throw new Error("Meta connection admin is no longer enabled.");
      const credentials = openGmail<MetaCredentials>(connection.data.credentials);
      let state = job;
      if (!state.application) {
        const lead = await getMetaLead(job.lead_id, credentials.page_token);
        if (lead.id !== job.lead_id) throw new Error("Meta returned a different lead.");
        state = await step("ingest", metaApplication(lead, job.form));
      }
      const application = state.application!;
      if (state.email_state === "pending" && connection.data.active) {
        // Preflight failures can retry safely. Once a send starts, ambiguous outcomes need review.
        if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error("Hiring notification email is not configured.");
        await step("email_start");
        let receipt: string | undefined;
        try {
          receipt = await sendApplicationNotification({ company_id: job.company_id, lead_id: job.lead_id,
            to: job.settings.notification_email, ...applicationEmail(application, job.settings) });
        } catch {
          problem = "Email delivery is uncertain. Check the hiring inbox before resending.";
        }
        // If this database write fails, the expired sending lease becomes uncertain, never an automatic resend.
        await step("email_finish", { state: receipt ? "sent" : "uncertain", receipt, ...(problem ? { error: problem } : {}) });
      }
      if (state.sms_state === "pending" && connection.data.active) {
        const integration = await db.from("hf_integrations").select("quo_api_key,quo_phone,quo_phone_id").eq("company_id", job.company_id).single();
        const quo = integration.data;
        if (integration.error || !quo?.quo_api_key || !quo.quo_phone || !quo.quo_phone_id) throw new Error("Connect Quo before sending application texts.");
        await step("sms_start");
        let delivery: "pending" | "sent" | "uncertain" = "uncertain", receipt: string | undefined;
        try {
          const response = await fetch("https://api.quo.com/v1/messages", {
            method: "POST", headers: { Authorization: quo.quo_api_key, "Content-Type": "application/json" },
            body: JSON.stringify({ from: quo.quo_phone, phoneNumberId: quo.quo_phone_id, to: [application.phone], content: job.form.sms }),
            signal: AbortSignal.timeout(15000),
          });
          if (response.ok) {
            const body = await response.json();
            if (typeof body.data?.id === "string") { receipt = body.data.id; delivery = "sent"; }
          } else if (response.status >= 400 && response.status < 500) {
            // Explicit rejections did not accept a message and can safely retry after connection/rate-limit recovery.
            delivery = "pending";
            problem = `Quo rejected the text (${response.status}). Check the Quo connection or messaging limit.`;
          }
        } catch { /* A timeout may happen after the provider accepts the message. */ }
        if (delivery === "uncertain") problem = "Text delivery is uncertain. Check Quo before resending.";
        await step("sms_finish", { state: delivery, receipt, ...(problem ? { error: problem } : {}) });
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : "Meta application could not be processed.";
    }
    await step("release", problem ? { error: problem } : {}).catch(() => {});
    processed++;
  }
  return { processed };
}

// Overlap the last successful poll to recover delayed/missed notifications. Stable lead IDs deduplicate both paths.
export async function pollMetaConnection(company: string, budget = 45000) {
  const db = adminDb(), end = Date.now() + budget;
  const result = await db.from("hf_meta_connections").select("*").eq("company_id", company).not("credentials", "is", null).single();
  if (result.error || !result.data) throw new Error("Connect Meta first.");
  const c = result.data;
  const member = await db.from("hf_members").select("enabled,role").eq("company_id", company).eq("user_id", c.connected_by).single();
  if (!member.data?.enabled || member.data.role !== "admin") throw new Error("Meta connection admin is no longer enabled.");
  const token = openGmail<MetaCredentials>(c.credentials).page_token;
  const started = new Date().toISOString();
  const since = Math.floor((c.last_polled_at ? Date.parse(c.last_polled_at) - 3600000 : Date.now() - 86400000) / 1000);
  try {
    for (const form of (c.settings as MetaSettings).forms) {
      let after: string | undefined;
      for (let page = 0; ; page++) {
        if (Date.now() > end - 16000 || page >= 20) throw new Error("Meta catch-up is incomplete. Retry sync to finish the import.");
        const body = await metaGet<{ data: { id: string }[]; paging?: { next?: string; cursors?: { after?: string } } }>(`${metaId.parse(form.id)}/leads`, token,
          { fields: "id", limit: "100", filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]), ...(after ? { after } : {}) });
        for (const lead of body.data) {
          const queued = await db.rpc("hf_meta_enqueue", { page: c.page_id, form_id: form.id, lead: metaId.parse(lead.id) });
          if (queued.error || !queued.data) throw new Error("Could not save Meta catch-up events.");
        }
        if (!body.paging?.next) break;
        after = body.paging.cursors?.after;
        if (!after) throw new Error("Could not continue Meta catch-up.");
      }
    }
    const updated = await db.rpc("hf_meta_set", { actor: c.connected_by, cid: company, operation: "polled",
      payload: { generation: c.updated_at, polled_at: started } });
    if (updated.error || !updated.data) throw new Error("Could not save Meta sync progress.");
  } catch (error) {
    await db.rpc("hf_meta_set", { actor: c.connected_by, cid: company, operation: "polled",
      payload: { generation: c.updated_at, error: (error as Error).message } });
    throw error;
  }
}

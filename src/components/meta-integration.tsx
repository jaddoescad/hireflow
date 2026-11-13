"use client";
import { useEffect, useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";
import { Field, when } from "./primitives";
import type { MetaForm, MetaSettings } from "@/lib/meta";

type Status = {
  connected: boolean; active: boolean; page_name?: string; page_id?: string; app_id?: string;
  callback_url: string; verify_token?: string; last_received_at?: string; last_polled_at?: string;
  last_error?: string; settings?: MetaSettings;
  jobs: { lead_id: string; state: string; email_state: string; sms_state: string; last_error?: string }[];
};
export function MetaIntegration({ company, name }: { company: string; name: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<MetaSettings>({ forms: [], notification_email: "", sender_name: `${name} Hiring` });
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [app, setApp] = useState("");
  const [page, setPage] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/meta?company=${encodeURIComponent(company)}`, { signal: controller.signal }).then(async r => {
      const value = await r.json();
      if (!r.ok) throw new Error(value.error);
      setStatus(value);
      if (value.settings) setSettings(value.settings);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [company]);
  async function action(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/meta", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: company, action, ...extra }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (action === "forms") { setForms(result.forms); return; }
      const updated = await fetch(`/api/meta?company=${encodeURIComponent(company)}`);
      const value = await updated.json();
      if (!updated.ok) throw new Error(value.error);
      setStatus(value);
      if (value.settings) setSettings(value.settings);
      if (action === "connect") { setSecret(""); setToken(""); }
      setMessage(action === "activate" ? "Direct delivery enabled. New applications will receive the saved email and text notifications."
        : action === "sync" ? "Sync finished. Review application delivery below." : "Saved.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function updateForm(id: string, change: Partial<MetaForm>) {
    setSettings(s => ({ ...s, forms: s.forms.map(f => f.id === id ? { ...f, ...change } : f) }));
  }
  return <section className="panel">
    <div className="panel-heading">
      <h2><Link2 size={18} /> Facebook Lead Ads</h2>
      <span className={`status ${status?.connected ? "enabled" : "disabled"}`}>
        {status?.active ? "Direct delivery on" : status?.connected ? "Verification mode" : "Not connected"}
      </span>
    </div>
    <div className="panel-form">
      <p>Receive hiring applications directly from Facebook. Every question and answer is saved to Notes. Choose the hiring forms, hiring inbox and application acknowledgement texts here.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="notice" role="status">{message}</p>}
      {status?.connected && <>
        <strong>{status.page_name}</strong>
        <p className="muted">{status.active ? "Email and text delivery are enabled for new applications."
          : "Applications are saved while you verify the connection. HireFlow sends no acknowledgement texts or hiring emails in this mode."}</p>
        {status.last_error && <p className="error">{status.last_error}</p>}
        <small>Last received: {status.last_received_at ? when(status.last_received_at) : "None yet"} · Last catch-up: {status.last_polled_at ? when(status.last_polled_at) : "Not run yet"}</small>
        <Field label="Hiring notification email"><input type="email" value={settings.notification_email} onChange={e => setSettings(s => ({ ...s, notification_email: e.target.value }))} placeholder="hiring@example.com" /></Field>
        <Field label="Email sender name"><input value={settings.sender_name} maxLength={100} onChange={e => setSettings(s => ({ ...s, sender_name: e.target.value }))} /></Field>
        <small>Leave the hiring email blank to turn off email notifications. Leave a form’s text blank to turn off its acknowledgement text.</small>
        {settings.forms.map(form => <fieldset key={form.id} disabled={busy}>
          <legend>{form.name}</legend>
          <Field label="Applicant type"><input value={form.applicant_type} maxLength={60} onChange={e => updateForm(form.id, { applicant_type: e.target.value })} placeholder="Interior, Exterior, Project Manager…" /></Field>
          <Field label="Position override"><input value={form.job_title} maxLength={100} onChange={e => updateForm(form.id, { job_title: e.target.value })} placeholder="Use applicant’s selected position" /></Field>
          <Field label="Acknowledgement text"><textarea value={form.sms} maxLength={1600} rows={4} onChange={e => updateForm(form.id, { sms: e.target.value })} /></Field>
          <button type="button" onClick={() => setSettings(s => ({ ...s, forms: s.forms.filter(f => f.id !== form.id) }))}><Trash2 size={14} /> Remove form</button>
        </fieldset>)}
        <div className="gmail-actions">
          <button disabled={busy} onClick={() => void action("forms")}>Load Facebook forms</button>
          {!!forms.length && <><select aria-label="Facebook hiring form" value={selected} onChange={e => setSelected(e.target.value)}>
            <option value="">Choose a hiring form</option>
            {forms.filter(f => !settings.forms.some(s => s.id === f.id)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select><button disabled={busy || !selected} onClick={() => {
            const form = forms.find(f => f.id === selected);
            if (form) setSettings(s => ({ ...s, forms: [...s.forms, { ...form, applicant_type: "", job_title: "", sms: "" }] }));
            setSelected("");
          }}><Plus size={14} /> Add form</button></>}
        </div>
        <button className="primary" disabled={busy || !settings.forms.length} onClick={() => void action("settings", { settings })}>Save hiring forms and messages</button>
        <details>
          <summary>Meta webhook setup</summary>
          <p>In your Meta app’s Webhooks settings, choose Page, enter this callback and verification token, then subscribe to leadgen. Subscribe the same app to this Facebook Page. Use a dedicated app if the existing Page callback serves another integration.</p>
          <Field label="Callback URL"><input value={status.callback_url} readOnly /></Field>
          <Field label="Verification token"><input value={status.verify_token || ""} readOnly /></Field>
        </details>
        <div className="gmail-actions">
          <button disabled={busy || !settings.forms.length} onClick={() => void action("sync")}>{busy ? "Please wait…" : "Sync now"}</button>
          {status.active ? <button disabled={busy} onClick={() => void action("pause")}>Pause email and text delivery</button>
            : <button disabled={busy || !settings.forms.length} onClick={() => {
              if (confirm("Turn off the old Zap first. Enable HireFlow to email the hiring inbox and send the saved acknowledgement texts for new applications?")) void action("activate");
            }}>Enable direct delivery</button>}
          <button disabled={busy} onClick={() => void action("retry")}>Retry failed applications</button>
        </div>
        {!!status.jobs.length && <details>
          <summary>Recent application delivery</summary>
          <p className="muted">“Uncertain” means the provider may have accepted a message. Check the hiring inbox or Quo before sending it manually. Retrying applications never resends an uncertain message.</p>
          {status.jobs.map(job => <div key={job.lead_id}>
            <small>Lead {job.lead_id} · {job.state} · Email: {job.email_state} · Text: {job.sms_state}</small>
            {job.last_error && (job.state !== "complete" || job.email_state === "uncertain" || job.sms_state === "uncertain") && <p className="error">{job.last_error}</p>}
          </div>)}
        </details>}
      </>}
      <details open={status?.connected === false}>
        <summary>{status?.connected ? "Replace or disconnect Facebook connection" : "Connect Facebook Page"}</summary>
        <p>Use a Meta app and a Page access token with lead retrieval and Page webhook permissions. Credentials are encrypted on the server.</p>
        <Field label="Meta app ID"><input value={app} inputMode="numeric" onChange={e => setApp(e.target.value)} autoComplete="off" /></Field>
        <Field label="Facebook Page ID"><input value={page} inputMode="numeric" onChange={e => setPage(e.target.value)} autoComplete="off" /></Field>
        <Field label="Meta app secret"><input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Page access token"><input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="new-password" /></Field>
        <button disabled={busy || !app || !page || !secret || !token} onClick={() => void action("connect", { app_id: app, page_id: page, app_secret: secret, page_token: token })}>Verify and connect Page</button>
        {status?.connected && <button disabled={busy} onClick={() => {
          if (confirm("Disconnect Facebook? Direct application intake and automatic messages will stop.")) void action("disconnect");
        }}>Disconnect Facebook</button>}
      </details>
    </div>
  </section>;
}

"use client";
import { useState } from "react";
import {
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  Link2,
  Phone,
  Copy,
  Check,
  Mail,
} from "lucide-react";
import type { Workspace, Stage } from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Field, Modal, when } from "./primitives";
import { ScoreSettings } from "./score-settings";
export function Settings({
  data,
  mutate,
  onRefresh,
}: {
  data: Workspace;
  mutate: Mutate;
  onRefresh: () => Promise<void>;
}) {
  const [stage, setStage] = useState<Stage | null | undefined>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const base = typeof window === "undefined" ? "" : location.origin;
  async function run(action: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const r = await mutate(action, payload);
      setSaved(true);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function googleAction(action: "connect" | "sync" | "disconnect") {
    if (action === "disconnect" && !confirm("Disconnect Google? Email import, interview scheduling and recording copies stop until an admin reconnects. Saved emails and recordings stay."))
      return;
    setBusy(true);
    setError("");
    try {
      const post = async (url: string, body: Record<string, unknown> = {}) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company_id: data.company?.id, ...body }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        return result;
      };
      if (action === "connect") {
        window.location.assign((await post("/api/google/connect")).url);
        return;
      }
      if (action === "sync") await Promise.all([post("/api/google", { action: "sync_email" }), post("/api/google", { action: "sync" })]);
      else await post("/api/google", { action: "disconnect" });
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google connection failed.");
    } finally {
      setBusy(false);
    }
  }
  const googleResult = typeof window === "undefined" ? null : new URLSearchParams(location.search).get("google");
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / SETTINGS</div>
          <h1>Make it your process</h1>
          <p>Stages, interview scores, and connections for {data.company?.name}.</p>
        </div>
      </header>
      <div className="content-body settings-grid">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {saved && (
          <div className="notice" role="status">
            Saved.
          </div>
        )}
        <ScoreSettings data={data} mutate={mutate} />
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <Mail size={18} /> Google Workspace
            </h2>
          </div>
          <div className="panel-form">
            <p>
              One company account for hiring. Candidate emails and resumes
              arrive in Chat, interviews are sent from its calendar with a Meet
              link, and recordings are saved for everyone on your team.
            </p>
            {data.integration?.google_connected ? (
              <>
                <p>
                  <strong>{data.integration.google_account}</strong>
                </p>
                <p className="muted">
                  {data.integration.gmail_synced_at
                    ? `Email last synced ${when(data.integration.gmail_synced_at)}`
                    : "First email sync in progress…"}
                </p>
                {data.integration.gmail_error && (
                  <p className="error">{data.integration.gmail_error}</p>
                )}
                {!data.integration.recording_storage && (
                  <p className="muted">
                    Recording storage is not set up on this server, so
                    recordings stay in this account&apos;s Google Drive.
                  </p>
                )}
                <div className="gmail-actions">
                  <button disabled={busy} onClick={() => void googleAction("sync")}>
                    {busy ? "Please wait…" : "Sync now"}
                  </button>
                  <button disabled={busy} onClick={() => void googleAction("connect")}>
                    Reconnect
                  </button>
                  <button disabled={busy} onClick={() => void googleAction("disconnect")}>
                    Disconnect
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">
                  Use a Google Workspace account with Meet recording, such as
                  your hiring inbox. HireFlow reads email, manages interview
                  events and copies Meet recordings. It never sends email.
                </p>
                <button
                  className="primary"
                  disabled={busy || !data.integration?.google_available}
                  onClick={() => void googleAction("connect")}
                >
                  Connect Google
                </button>
                {!data.integration?.google_available && (
                  <p className="muted">
                    The workspace owner needs to finish Google setup.
                  </p>
                )}
              </>
            )}
            {googleResult === "connected" && (
              <p className="notice" role="status">Google connected. HireFlow is syncing email and interviews.</p>
            )}
            {googleResult && googleResult !== "connected" && (
              <p className="error">
                {googleResult === "not-workspace"
                  ? "Connect a Google Workspace account. Meet recording is not available for personal Google accounts."
                  : googleResult === "permissions"
                    ? "Google wasn't connected. Allow every requested permission so email, interviews and recordings work."
                    : "Google wasn't connected. Try again."}
              </p>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Company</h2>
          </div>
          <form
            className="panel-form inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run("rename_company", {
                name: new FormData(e.currentTarget).get("name"),
              });
            }}
          >
            <Field label="Company name">
              <input
                name="name"
                defaultValue={data.company?.name}
                required
                maxLength={100}
              />
            </Field>
            <button className="primary" disabled={busy}>
              Save
            </button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Hiring stages</h2>
            <button onClick={() => setStage(null)}>
              <Plus size={16} /> Add stage
            </button>
          </div>
          <p className="panel-description">
            The first stage receives new applications. Move candidates out of a
            stage before deleting it.
          </p>
          <div className="stage-settings">
            {data.stages.map((s, index) => (
              <div className="stage-setting" key={s.id}>
                <span className={`stage-dot tone-${s.color}`} />
                <button className="text-button" onClick={() => setStage(s)}>
                  {s.name}
                </button>
                <span>
                  {data.candidates.filter((c) => c.stage_id === s.id).length}{" "}
                  candidates
                </span>
                <button
                  className="icon-button"
                  aria-label={`Move ${s.name} up`}
                  disabled={busy || index === 0}
                  onClick={() =>
                    void run("stage_reorder", { id: s.id, direction: "up" })
                  }
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move ${s.name} down`}
                  disabled={busy || index === data.stages.length - 1}
                  onClick={() =>
                    void run("stage_reorder", { id: s.id, direction: "down" })
                  }
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${s.name}`}
                  disabled={
                    busy ||
                    data.candidates.some((c) => c.stage_id === s.id) ||
                    data.stages.length === 1
                  }
                  onClick={() => void run("stage_delete", { id: s.id })}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <Link2 size={18} /> Applicant intake
            </h2>
            <span
              className={`status ${data.integration?.intake_configured ? "enabled" : "disabled"}`}
            >
              {data.integration?.intake_configured
                ? "Token configured"
                : "Not connected"}
            </span>
          </div>
          <div className="panel-form">
            <p>
              Add a Webhooks by Zapier POST action after your existing Google
              Sheets action.
            </p>
            <Field label="Webhook URL">
              <input value={`${base}/api/webhooks/intake`} readOnly />
            </Field>
            <p className="muted">
              Send your token in the Authorization header as Bearer YOUR_TOKEN.
              Keep the same source_id when retrying an application.
            </p>
            <button
              disabled={busy}
              onClick={async () => {
                const r = await run("integration", { rotate_intake: true });
                if (r?.intake_key) setKey(String(r.intake_key));
              }}
            >
              {data.integration?.intake_configured
                ? "Replace intake token"
                : "Generate intake token"}
            </button>
            {data.integration?.intake_configured && (
              <small>
                Replacing the token disconnects the old Zap until you update its
                Authorization header.
              </small>
            )}
            {key && (
              <div className="secret-output">
                <strong>Copy your token now</strong>
                <input aria-label="New intake token" readOnly value={key} />
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(key);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
                  {copied ? "Copied" : "Copy token"}
                </button>
              </div>
            )}
            <details>
              <summary>Example application payload</summary>
              <pre>
                {JSON.stringify(
                  {
                    source_id: "meta-lead-123",
                    name: "Alex Example",
                    email: "alex@example.com",
                    phone: "+16135550123",
                    job_title: "Painter",
                    experience: "3–5 years",
                    tags: ["Own vehicle"],
                    attributes: { availability: "Full time" },
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <small>
              Last application:{" "}
              {data.integration?.last_intake_at
                ? when(data.integration.last_intake_at)
                : "No applications received yet"}
            </small>
          </div>
        </section>
        <section className="panel quo-panel">
          <div className="panel-heading">
            <h2>
              <Phone size={18} /> Quo
            </h2>
            <span
              className={`status ${data.integration?.quo_configured ? "enabled" : "disabled"}`}
            >
              {data.integration?.quo_configured
                ? "Configured"
                : "Not connected"}
            </span>
          </div>
          <div className="quo-summary">
            {data.integration?.quo_phone && (
              <strong>{data.integration.quo_phone}</strong>
            )}
            <small>
              Last event:{" "}
              {data.integration?.last_quo_at
                ? when(data.integration.last_quo_at)
                : "No events received yet"}
            </small>
          </div>
          <details className="quo-settings" open={!data.integration?.quo_configured}>
            <summary>
              {data.integration?.quo_configured ? "Edit connection" : "Connect Quo"}
            </summary>
            <form
              className="panel-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const r = await run("integration", {
                  quo_api_key: f.get("quo_api_key"),
                  quo_phone_id: f.get("quo_phone_id"),
                  quo_phone: f.get("quo_phone"),
                  quo_signing_secret: f.get("quo_signing_secret"),
                });
                if (r) {
                  (e.target as HTMLFormElement)
                    .querySelectorAll<HTMLInputElement>('input[type="password"]')
                    .forEach((i) => (i.value = ""));
                }
              }}
            >
              <p>Connect the number your team uses to speak with candidates.</p>
              <Field label="Quo API key">
                <input
                  name="quo_api_key"
                  type="password"
                  autoComplete="off"
                  placeholder="Leave blank to keep current key"
                />
              </Field>
              <div className="form-grid">
                <Field label="Phone number ID">
                  <input
                    name="quo_phone_id"
                    defaultValue={data.integration?.quo_phone_id || ""}
                    placeholder="PN…"
                    required
                  />
                </Field>
                <Field label="Phone number">
                  <input
                    name="quo_phone"
                    type="tel"
                    defaultValue={data.integration?.quo_phone || ""}
                    placeholder="+13433265133"
                    required
                  />
                </Field>
              </div>
              <Field label="Webhook URL">
                <input
                  readOnly
                  value={`${base}/api/webhooks/quo/${data.company?.id}`}
                />
              </Field>
              <p className="muted">
                In Quo, subscribe this URL to incoming and outgoing messages and
                completed calls for this number. Paste the message and call
                signing secrets below, separated by commas.
              </p>
              <Field label="Webhook signing secrets">
                <input
                  name="quo_signing_secret"
                  type="password"
                  autoComplete="off"
                  placeholder="Leave blank to keep current secret"
                />
              </Field>
              <button className="primary" disabled={busy}>
                Save Quo connection
              </button>
            </form>
          </details>
        </section>
      </div>
      {stage !== undefined && (
        <Modal
          title={stage ? "Edit stage" : "Add stage"}
          onClose={() => setStage(undefined)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const r = await run("stage_save", {
                ...(stage ? { id: stage.id } : {}),
                name: f.get("name"),
                color: f.get("color"),
                position:
                  stage?.position ??
                  Math.max(-1, ...data.stages.map((s) => s.position)) + 1,
              });
              if (r) setStage(undefined);
            }}
          >
            <Field label="Stage name">
              <input
                name="name"
                defaultValue={stage?.name}
                required
                maxLength={60}
                autoFocus
              />
            </Field>
            <Field label="Color">
              <select name="color" defaultValue={stage?.color || "blue"}>
                {["blue", "slate", "violet", "amber", "green", "red"].map(
                  (c) => (
                    <option key={c}>{c}</option>
                  ),
                )}
              </select>
            </Field>
            {error && <p className="error">{error}</p>}
            <footer className="form-actions">
              <button className="primary" disabled={busy}>
                Save stage
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}

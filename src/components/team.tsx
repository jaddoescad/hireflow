"use client";
import { useState } from "react";
import { Mail, Plus, ShieldCheck, Copy, Check } from "lucide-react";
import type { Workspace } from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Avatar, Modal, Field, when } from "./primitives";
export function Team({ data, mutate }: { data: Workspace; mutate: Mutate }) {
  const [invite, setInvite] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const admin = data.membership?.role === "admin";
  const pending = data.invitations.filter(
    (i) => !i.accepted_at && !i.revoked_at,
  );
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / TEAM</div>
          <h1>Your hiring team</h1>
          <p>Manage access to {data.company?.name}.</p>
        </div>
        {admin && (
          <button
            className="primary"
            onClick={() => {
              setInvite(true);
              setResult(null);
              setError("");
            }}
          >
            <Plus size={18} /> Invite teammate
          </button>
        )}
      </header>
      <div className="content-body">
        <section className="panel">
          <div className="panel-heading">
            <h2>
              Members <span className="count">{data.members.length}</span>
            </h2>
            <span>
              <ShieldCheck size={16} /> Company access
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  {admin && <th>Access</th>}
                </tr>
              </thead>
              <tbody>
                {data.members.map((m) => (
                  <tr key={m.user_id}>
                    <td>
                      <div className="table-person">
                        <Avatar name={m.email} />
                        <div>
                          <strong>{m.email}</strong>
                          {m.user_id === data.user.id && <small>You</small>}
                        </div>
                      </div>
                    </td>
                    <td>
                      {admin ? (
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={m.role}
                          onChange={(e) =>
                            void mutate("member", {
                              user_id: m.user_id,
                              enabled: m.enabled,
                              role: e.target.value,
                            }).catch(() => {})
                          }
                        >
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                        </select>
                      ) : (
                        m.role
                      )}
                    </td>
                    <td>
                      <span
                        className={`status ${m.enabled ? "enabled" : "disabled"}`}
                      >
                        {m.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    {admin && (
                      <td>
                        <button
                          onClick={() =>
                            void mutate("member", {
                              user_id: m.user_id,
                              role: m.role,
                              enabled: !m.enabled,
                            }).catch(() => {})
                          }
                        >
                          {m.enabled ? "Disable" : "Enable"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {admin && (
          <section className="panel">
            <div className="panel-heading">
              <h2>Invitations</h2>
            </div>
            {pending.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((i) => (
                      <tr key={i.id}>
                        <td>{i.email}</td>
                        <td>{i.role}</td>
                        <td>
                          {new Date(i.expires_at) < new Date()
                            ? "Expired"
                            : when(i.expires_at)}
                        </td>
                        <td>
                          <button
                            onClick={() =>
                              void mutate("revoke_invitation", {
                                id: i.id,
                              }).catch(() => {})
                            }
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="panel-empty">No pending invitations.</p>
            )}
          </section>
        )}
      </div>
      {invite && (
        <Modal title="Invite a teammate" onClose={() => setInvite(false)}>
          {result ? (
            <div className="invite-result">
              <Mail size={28} />
              <h3>
                {result.email_sent
                  ? "Invitation sent"
                  : "Invitation link ready"}
              </h3>
              <p>
                {result.email_sent
                  ? "They’ll receive an email with a link to join your company."
                  : String(
                      result.email_error ||
                        "Email delivery is not configured yet. Share this invitation link with your teammate.",
                    )}
              </p>
              <input
                aria-label="Invitation link"
                readOnly
                value={String(result.invitation_url)}
              />
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    String(result.invitation_url),
                  );
                  setCopied(true);
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(true);
                setError("");
                try {
                  setResult(
                    await mutate("invite", {
                      email: f.get("email"),
                      role: f.get("role"),
                    }),
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not invite");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>They can use their existing HireFlow account to join.</p>
              <Field label="Email address">
                <input
                  name="email"
                  type="email"
                  placeholder="teammate@company.com"
                  required
                  autoFocus
                />
              </Field>
              <Field label="Role">
                <select name="role">
                  <option value="member">Member — manage candidates</option>
                  <option value="admin">
                    Admin — manage candidates, team and settings
                  </option>
                </select>
              </Field>
              {error && <p className="error">{error}</p>}
              <footer className="form-actions">
                <button className="primary" disabled={busy}>
                  {busy ? "Inviting…" : "Send invitation"}
                </button>
              </footer>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}

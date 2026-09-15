"use client";
import { useEffect, useState } from "react";
import {
  Phone,
  Mail,
  MessageSquare,
  StickyNote,
  ArrowRight,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import type { Activity, Candidate, Workspace } from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Avatar, Field, Modal, when, Empty } from "./primitives";
export function CandidateEditor({
  candidate,
  data,
  mutate,
  onClose,
}: {
  candidate: Candidate | null;
  data: Workspace;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await mutate("candidate_save", {
        ...(candidate ? { id: candidate.id } : {}),
        name: f.get("name"),
        email: f.get("email"),
        phone: f.get("phone"),
        job_title: f.get("job_title"),
        experience: f.get("experience"),
        stage_id: f.get("stage_id"),
        tags: [
          ...new Set(
            String(f.get("tags"))
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ],
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={candidate ? "Edit candidate" : "Add candidate"}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <Field label="Full name">
          <input
            name="name"
            defaultValue={candidate?.name}
            required
            maxLength={160}
            autoFocus
          />
        </Field>
        <div className="form-grid">
          <Field label="Email">
            <input
              name="email"
              type="email"
              defaultValue={candidate?.email || ""}
            />
          </Field>
          <Field label="Phone">
            <input
              name="phone"
              type="tel"
              placeholder="+1 613 555 0123"
              defaultValue={candidate?.phone || ""}
            />
          </Field>
          <Field label="Applying for">
            <input
              name="job_title"
              defaultValue={candidate?.job_title}
              placeholder="Painter"
              maxLength={100}
            />
          </Field>
          <Field label="Experience">
            <input
              name="experience"
              defaultValue={candidate?.experience}
              placeholder="3–5 years"
              maxLength={100}
            />
          </Field>
        </div>
        <Field label="Stage">
          <select
            name="stage_id"
            defaultValue={candidate?.stage_id || data.stages[0]?.id}
            required
          >
            {data.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags, separated by commas">
          <input
            name="tags"
            defaultValue={candidate?.tags.join(", ")}
            placeholder="Own vehicle, Interior painting"
          />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save candidate"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function CandidateDetail({
  candidate: c,
  data,
  mutate,
  onClose,
  onEdit,
}: {
  candidate: Candidate;
  data: Workspace;
  mutate: Mutate;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [tab, setTab] = useState("activity");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [activities, setActivities] = useState<Activity[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const historyUrl = `/api/activities?company=${c.company_id}&candidate=${c.id}&notes=${tab === "notes" ? "1" : "0"}`;
  const historyVersion = data.activities
    .filter((a) => a.candidate_id === c.id)
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    setActivities([]);
    setHistoryPage(0);
    fetch(historyUrl, { signal: controller.signal })
      .then(async (r) => {
        const result = await r.json();
        if (!r.ok) throw new Error(result.error);
        setActivities(result.activities);
        setHasMore(result.has_more);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [historyUrl, historyVersion]);
  async function moreHistory() {
    setHistoryLoading(true);
    try {
      const r = await fetch(`${historyUrl}&page=${historyPage + 1}`);
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      setActivities((current) => [...current, ...result.activities]);
      setHistoryPage((p) => p + 1);
      setHasMore(result.has_more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history");
    } finally {
      setHistoryLoading(false);
    }
  }
  return (
    <Modal title="Candidate" onClose={onClose} wide>
      <div className="detail-top">
        <Avatar name={c.name} />
        <div>
          <h2>{c.name}</h2>
          <p>{c.job_title || "Role not specified"}</p>
        </div>
        <button onClick={onEdit}>Edit</button>
      </div>
      <div className="contact-lines">
        {c.phone ? (
          <a href={`tel:${c.phone}`}>
            <Phone size={16} />
            {c.phone}
            <ExternalLink size={13} />
          </a>
        ) : (
          <span>No phone number</span>
        )}
        {c.email ? (
          <span>
            <Mail size={16} />
            {c.email}
          </span>
        ) : (
          <span>No email address</span>
        )}
      </div>
      <div className="tags">
        {c.experience && <span>{c.experience}</span>}
        {c.tags.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <Field label="Hiring stage">
        <select
          value={c.stage_id}
          onChange={(e) =>
            void mutate("move", { id: c.id, stage_id: e.target.value }).catch(
              () => {},
            )
          }
        >
          {data.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="tabs" role="tablist">
        {["activity", "notes", "details"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "details" ? (
        <dl className="details-list">
          <dt>Source</dt>
          <dd>{c.source}</dd>
          <dt>Applied</dt>
          <dd>{when(c.created_at)}</dd>
          {Object.entries(c.attributes).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v ?? "—")}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <>
          <div className="timeline">
            {historyLoading && activities.length === 0 && (
              <p className="muted">Loading history…</p>
            )}
            {activities.length ? (
              activities.map((a) => (
                <article key={a.id} className={`activity ${a.kind}`}>
                  <span className="activity-icon">
                    {a.kind === "sms" ? (
                      <MessageSquare size={16} />
                    ) : a.kind === "call" ? (
                      <Phone size={16} />
                    ) : a.kind === "note" ? (
                      <StickyNote size={16} />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                  </span>
                  <div>
                    <header>
                      <strong>
                        {a.kind === "sms"
                          ? "Text message"
                          : a.kind === "call"
                            ? "Phone call"
                            : a.kind === "note"
                              ? "Team note"
                              : "Stage changed"}
                      </strong>
                      <time>{when(a.occurred_at)}</time>
                    </header>
                    <p>{a.body}</p>
                    {a.direction && (
                      <small>
                        {a.direction === "incoming"
                          ? "From candidate"
                          : "From your team"}{" "}
                        · Quo
                      </small>
                    )}
                  </div>
                </article>
              ))
            ) : historyLoading ? null : (
              <Empty
                title={
                  tab === "notes" ? "No notes yet" : "Start the conversation"
                }
                detail="Notes and Quo communication will appear here."
              />
            )}
          </div>
          {hasMore && (
            <button
              disabled={historyLoading}
              onClick={() => void moreHistory()}
            >
              {historyLoading ? "Loading…" : "Load older activity"}
            </button>
          )}
          <form
            className="note-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await mutate("note", { candidate_id: c.id, body: note });
                setNote("");
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not save note",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Add a team note">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What should the team know?"
                required
                maxLength={10000}
              />
            </Field>
            <button className="primary" disabled={busy || !note.trim()}>
              {busy ? "Saving…" : "Save note"}
            </button>
          </form>
        </>
      )}
      {c.phone && (
        <div className="detail-footer">
          <a href={`https://my.quo.com/`} target="_blank" rel="noreferrer">
            Open Quo <ExternalLink size={14} />
          </a>
          <button
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setError("");
              try {
                await mutate("quo_sync", { candidate_id: c.id });
              } catch (e) {
                setError(e instanceof Error ? e.message : "Sync failed");
              } finally {
                setSyncing(false);
              }
            }}
          >
            <RefreshCw size={14} />
            {syncing ? "Syncing…" : "Sync history"}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

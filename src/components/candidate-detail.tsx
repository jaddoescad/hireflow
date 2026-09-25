"use client";
import { EmailContent } from "./email-content";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CalendarPlus,
  Mail,
  Pencil,
  Phone,
  StickyNote,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import type { Activity, Candidate, Workspace } from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Field, Modal, when, Empty } from "./primitives";
import { InterviewScorecard } from "./interview-scorecard";
import { InterviewEditor } from "./interviews";
import { CandidateRecordings } from "./recordings";
const experienceLevels = [
  "Less than 1 year",
  "1-2 years",
  "3-5 years",
  "5+ years",
];
// Distinct non-empty values, most used first, plus the current value.
function choices(values: string[], current?: string) {
  const counts = new Map<string, number>();
  for (const v of values)
    if (v?.trim()) counts.set(v, (counts.get(v) || 0) + 1);
  if (current?.trim() && !counts.has(current)) counts.set(current, 0);
  return [...counts.keys()].sort(
    (a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b),
  );
}
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
  const positions = choices(
    data.candidates.map((c) => c.job_title),
    candidate?.job_title,
  );
  const [position, setPosition] = useState(candidate?.job_title || "");
  const [customPosition, setCustomPosition] = useState(false);
  const knownTags = choices(data.candidates.flatMap((c) => c.tags));
  const [tags, setTags] = useState(candidate?.tags || []);
  const [newTag, setNewTag] = useState("");
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
        job_title: position.trim(),
        experience: f.get("experience"),
        stage_id: f.get("stage_id"),
        tags: [...new Set([...tags, newTag.trim()].filter(Boolean))],
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
          <Field label="Position">
            {customPosition ? (
              <input
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                placeholder="New position"
                maxLength={100}
                autoFocus
              />
            ) : (
              <select
                value={position}
                onChange={(e) => {
                  if (e.target.value === "__other__") {
                    setPosition("");
                    setCustomPosition(true);
                  } else setPosition(e.target.value);
                }}
              >
                <option value="">Not specified</option>
                {positions.map((p) => (
                  <option key={p}>{p}</option>
                ))}
                <option value={"__other__"}>Other…</option>
              </select>
            )}
          </Field>
          <Field label="Experience">
            <select
              name="experience"
              defaultValue={candidate?.experience || ""}
            >
              <option value="">Not specified</option>
              {choices(experienceLevels, candidate?.experience).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
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
        <fieldset className="tag-picker">
          <legend>Tags</legend>
          {choices([...knownTags, ...tags]).map((t) => (
            <label key={t}>
              <input
                type="checkbox"
                checked={tags.includes(t)}
                onChange={(e) =>
                  setTags(
                    e.target.checked
                      ? [...tags, t]
                      : tags.filter((x) => x !== t),
                  )
                }
              />
              {t}
            </label>
          ))}
          <input
            aria-label="New tag"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="Add a new tag"
            maxLength={60}
          />
        </fieldset>
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
  onRefresh,
}: {
  candidate: Candidate;
  data: Workspace;
  mutate: Mutate;
  onClose: () => void;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState("chat");
  const [scheduling, setScheduling] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [scoresDirty, setScoresDirty] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [activities, setActivities] = useState<Activity[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const olderHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = conversation.current;
    if (!el || tab !== "chat") return;
    el.scrollTop =
      olderHeight.current === null
        ? el.scrollHeight
        : el.scrollHeight - olderHeight.current;
    olderHeight.current = null;
  }, [activities, tab]);
  const historyUrl = `/api/activities?company=${c.company_id}&candidate=${c.id}&notes=${tab === "notes" ? "1" : "0"}&chat=${tab === "chat" ? "1" : "0"}`;
  const historyVersion = data.activities
    .filter(
      (a) =>
        a.candidate_id === c.id &&
        (tab === "chat"
          ? ["sms", "call", "email"].includes(a.kind)
          : a.kind === "note"),
    )
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    if (tab !== "chat" && tab !== "notes") return;
    const controller = new AbortController();
    historyRequest.current = controller;
    setError("");
    setHistoryLoading(true);
    setActivities([]);
    setHistoryPage(0);
    setHasMore(false);
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
  }, [historyUrl, historyVersion, tab]);
  async function moreHistory() {
    const controller = historyRequest.current;
    if (!controller || controller.signal.aborted) return;
    setHistoryLoading(true);
    try {
      const r = await fetch(`${historyUrl}&page=${historyPage + 1}`, {
        signal: controller.signal,
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      if (controller.signal.aborted) return;
      olderHeight.current = conversation.current?.scrollHeight ?? null;
      setActivities((current) => [...current, ...result.activities]);
      setHistoryPage((p) => p + 1);
      setHasMore(result.has_more);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not load history");
    } finally {
      if (!controller.signal.aborted) setHistoryLoading(false);
    }
  }
  return (
    <Modal
      title={c.name}
      onClose={() => {
        if (
          !scoresDirty ||
          window.confirm("Discard your unsaved interview scores?")
        )
          onClose();
      }}
      wide
      className="candidate-dialog"
    >
      <div className="candidate-head">
        <p className="candidate-role">
          {[c.job_title || "Role not specified", c.experience]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="candidate-contact">
          {c.email ? (
            <a href={`mailto:${c.email}`}>
              <Mail size={14} />
              {c.email}
            </a>
          ) : (
            <span className="muted">No email</span>
          )}
          {c.phone ? (
            <a href={`tel:${c.phone}`}>
              <Phone size={14} />
              {c.phone}
            </a>
          ) : (
            <span className="muted">No phone number</span>
          )}
        </div>
        {c.tags.length > 0 && (
          <div className="tags candidate-tags">
            {c.tags.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        )}
        <div className="candidate-actions">
          <select
            aria-label="Hiring stage"
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
          <button
            className="primary"
            onClick={() => {
              setScheduled(false);
              setScheduling(true);
            }}
          >
            <CalendarPlus size={15} /> Schedule interview
          </button>
          <button
            onClick={() => {
              if (
                !scoresDirty ||
                window.confirm("Discard your unsaved interview scores?")
              )
                onEdit();
            }}
          >
            <Pencil size={15} /> Edit
          </button>
        </div>
        {scheduled && (
          <p role="status" className="interview-notice">
            Interview scheduled. Google invitations and the Meet link are on
            their way; see Calendar for details.
          </p>
        )}
      </div>
      <div className="tabs" role="tablist">
        {["chat", "notes", "scores", "recordings", "details"].map((t) => (
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
      <div className="scorecard-slot" hidden={tab !== "scores"}>
        <InterviewScorecard
          key={c.id}
          candidate={c}
          data={data}
          mutate={mutate}
          active={tab === "scores"}
          onDirtyChange={setScoresDirty}
        />
      </div>
      {tab === "scores" ? null : tab === "recordings" ? (
        <CandidateRecordings data={data} candidateId={c.id} />
      ) : tab === "details" ? (
        <dl className="details-list">
          <dt>Source</dt>
          <dd>{c.source}</dd>
          <dt>Added</dt>
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
          <div
            className={tab === "chat" ? "conversation" : "timeline"}
            ref={conversation}
            role="region"
            aria-label={tab === "chat" ? "Conversation" : "Team notes"}
          >
            {hasMore && (
              <button
                className="load-older"
                disabled={historyLoading}
                onClick={() => void moreHistory()}
              >
                {historyLoading ? "Loading…" : "Load older"}
              </button>
            )}
            {historyLoading && activities.length === 0 && (
              <p className="muted">Loading…</p>
            )}
            {(tab === "chat" ? [...activities].reverse() : activities).map(
              (a) =>
                tab === "chat" ? (
                  a.kind === "call" ? (
                    <article key={a.id} className="chat-call">
                      <Phone size={14} />
                      <div>
                        <p>{a.body}</p>
                        <time>{when(a.occurred_at)}</time>
                      </div>
                    </article>
                  ) : (
                    <article
                      key={a.id}
                      className={`chat-message ${a.direction === "outgoing" ? "outgoing" : "incoming"}`}
                    >
                      {a.kind === "email" ? (
                        <EmailContent activity={a} />
                      ) : (
                        <p>{a.body}</p>
                      )}
                      <time>
                        <span className="sr-only">
                          {a.direction === "outgoing"
                            ? "Your team: "
                            : "Candidate: "}
                        </span>
                        {when(a.occurred_at)}
                      </time>
                    </article>
                  )
                ) : (
                  <article key={a.id} className="activity note">
                    <span className="activity-icon">
                      <StickyNote size={16} />
                    </span>
                    <div>
                      <header>
                        <strong>Team note</strong>
                        <time>{when(a.occurred_at)}</time>
                      </header>
                      <p>{a.body}</p>
                    </div>
                  </article>
                ),
            )}
            {!historyLoading && !activities.length && (
              <Empty
                title={tab === "notes" ? "No notes yet" : "No conversation yet"}
                detail={
                  tab === "notes"
                    ? "Keep interview notes here."
                    : "Emails, messages and calls will appear here."
                }
              />
            )}
          </div>
          {tab === "notes" && (
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
          )}
        </>
      )}
      {tab === "chat" && c.phone && (
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
      {scheduling && (
        <InterviewEditor
          data={data}
          session={null}
          candidateId={c.id}
          onClose={() => setScheduling(false)}
          onSave={() => {
            setScheduling(false);
            setScheduled(true);
            onRefresh();
          }}
        />
      )}
    </Modal>
  );
}

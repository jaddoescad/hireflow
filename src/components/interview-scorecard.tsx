"use client";
import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import type {
  Candidate,
  CandidateScore,
  ScorecardData,
  Workspace,
} from "@/lib/types";
import type { Mutate } from "./hiring-board";
import { Empty, when } from "./primitives";
import { scoreSummary } from "@/lib/score-summary";

type Draft = { rating: number | null; note: string };
const tone = (rating: number | null) => rating === null ? "unrated" : rating >= 8 ? "high" : rating >= 6 ? "medium" : "low";

export function InterviewScorecard({
  candidate,
  data,
  mutate,
  active,
  onDirtyChange,
}: {
  candidate: Candidate;
  data: Workspace;
  mutate: Mutate;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [scorecard, setScorecard] = useState<ScorecardData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copiedText, setCopiedText] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const dirty = Object.keys(drafts).length > 0;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const fetchScores = useCallback(
    async (signal?: AbortSignal): Promise<ScorecardData> => {
      const response = await fetch(
        `/api/scores?company=${candidate.company_id}&candidate=${candidate.id}`,
        {
          cache: "no-store",
          signal,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not load interview scores.");
      return result;
    },
    [candidate.company_id, candidate.id],
  );

  useEffect(() => {
    if (!active || scorecard) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchScores(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setScorecard(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, scorecard, fetchScores, attempt]);

  async function reload() {
    if (
      dirty &&
      !window.confirm(
        "Discard your unsaved scores and load the latest saved ratings?",
      )
    )
      return;
    setLoading(true);
    setError("");
    setSaved(false);
    try {
      setScorecard(await fetchScores());
      setDrafts({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reload scores.");
    } finally {
      setLoading(false);
    }
  }

  function change(id: string, patch: Partial<Draft>) {
    const original = scorecard?.scores.find((s) => s.category_id === id);
    setDrafts((current) => {
      const next = { ...current };
      const value = {
        ...(current[id] ?? {
          rating: original?.rating ?? null,
          note: original?.note ?? "",
        }),
        ...patch,
      };
      if (
        value.rating === (original?.rating ?? null) &&
        value.note === (original?.note ?? "")
      )
        delete next[id];
      else next[id] = value;
      return next;
    });
    setSaved(false);
  }

  if (!scorecard)
    return (
      <div className="scorecard-loading" role="status">
        {loading ? (
          <p>Loading interview scores…</p>
        ) : error ? (
          <>
            <p className="error" role="alert">
              {error}
            </p>
            <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
          </>
        ) : null}
      </div>
    );

  const categories = scorecard.categories.filter(
    (category) => !category.archived_at,
  );
  const archived = scorecard.categories.filter(
    (category) => category.archived_at,
  );
  const assessed = categories.filter(
    (category) =>
      (drafts[category.id]?.rating !== undefined
        ? drafts[category.id].rating
        : scorecard.scores.find((s) => s.category_id === category.id)
            ?.rating) != null,
  ).length;
  const total = categories.reduce(
    (sum, category) =>
      sum +
      ((
        drafts[category.id] ??
        scorecard.scores.find((s) => s.category_id === category.id)
      )?.rating ?? 0),
    0,
  );
  const canEdit = !!data.membership?.enabled;
  const summary = scoreSummary(candidate, categories.map((category) => {
    const score = drafts[category.id] ?? scorecard.scores.find((s) => s.category_id === category.id);
    return { name: category.name, rating: score?.rating ?? null, note: score?.note ?? "" };
  }), dirty);
  const disabled = saving || loading || !canEdit;
  function attribution(score?: CandidateScore) {
    if (!score) return null;
    const reviewer =
      score.updated_by === data.user.id
        ? "You"
        : data.members.find((member) => member.user_id === score.updated_by)
            ?.email || "Former team member";
    return (
      <small>
        {reviewer} · {when(score.updated_at)}
      </small>
    );
  }

  return (
    <form
      className="interview-scorecard"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!dirty || disabled) return;
        setSaving(true);
        setError("");
        setSaved(false);
        try {
          const result = await mutate("scores_save", {
            rating_scale: 10,
            candidate_id: candidate.id,
            scores: Object.entries(drafts).map(([category_id, draft]) => ({
              category_id,
              ...draft,
              expected_version:
                scorecard.scores.find((s) => s.category_id === category_id)
                  ?.version ?? null,
            })),
          });
          const updated = result.scores as CandidateScore[];
          setScorecard(
            (current) =>
              current && {
                ...current,
                scores: [
                  ...current.scores.filter(
                    (s) =>
                      !updated.some(
                        (next) => next.category_id === s.category_id,
                      ),
                  ),
                  ...updated,
                ],
              },
          );
          setDrafts({});
          setSaved(true);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not save scores.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="scorecard-body">
        <div className="scorecard-copy">
          <h3>Scores</h3>
          <span className={`scorecard-average score-tone-${tone(assessed ? total / assessed : null)}`} title={`${assessed} of ${categories.length} assessed${dirty ? " · Unsaved changes" : ""}`}>
            {assessed ? `${(total / assessed).toFixed(1)}/10` : "—"}
            <span className="sr-only"> · {assessed} of {categories.length} assessed{dirty ? " · Unsaved changes" : ""}</span>
          </span>
          <button type="button" disabled={loading || saving} onClick={async () => {
            try {
              await navigator.clipboard.writeText(summary);
              setCopiedText(summary);
              setCopyFailed(false);
            } catch {
              setCopyFailed(true);
            }
          }}>
            {copiedText === summary ? "Copied!" : "Copy summary"}
          </button>
          <span className="sr-only" role="status">{copiedText === summary ? "Interview summary copied." : ""}</span>
        </div>
        {copyFailed && <label className="score-copy-fallback">
          Clipboard unavailable. Select and copy this summary:
          <textarea aria-label="Interview summary to copy" readOnly value={summary} rows={6} onFocus={(event) => event.currentTarget.select()} />
        </label>}
        {!categories.length && (
          <Empty
            title="No score categories"
            detail={
              data.membership?.role === "admin"
                ? "Add categories in Settings → Interview scorecard to start rating candidates."
                : "Ask a company admin to add categories in Settings."
            }
          />
        )}
        {categories.map((category) => {
          const score = scorecard.scores.find(
            (s) => s.category_id === category.id,
          );
          const value = drafts[category.id] ?? {
            rating: score?.rating ?? null,
            note: score?.note ?? "",
          };
          return (
            <fieldset
              className="scorecard-category"
              key={category.id}
              disabled={disabled}
            >
              <legend className="sr-only">{category.name}</legend>
              <div className="scorecard-row">
                <label htmlFor={`rating-${category.id}`}>
                  {category.name}
                </label>
                <input
                  id={`rating-${category.id}`}
                  className={`score-value score-tone-${tone(value.rating)}`}
                  type="text"
                  inputMode="numeric"
                  pattern="10|[0-9]"
                  maxLength={2}
                  autoComplete="off"
                  aria-label={`${category.name} score out of 10`}
                  title="Enter 0–10. Clear to mark not assessed."
                  placeholder="—"
                  value={value.rating ?? ""}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => {
                    const text = event.target.value;
                    if (text === "" || /^(10|[0-9])$/.test(text)) {
                      change(category.id, { rating: text === "" ? null : Number(text) });
                    }
                  }}
                />
                <button
                  type="button"
                  className={`score-details-toggle ${value.note.trim() ? "has-note" : ""}`}
                  title={value.note.trim() ? "View interview notes" : "Add interview notes"}
                  aria-label={`${expanded[category.id] ? "Hide" : "Show"} ${category.name} notes`}
                  aria-expanded={!!expanded[category.id]}
                  aria-controls={`score-details-${category.id}`}
                  onClick={() => setExpanded((current) => ({ ...current, [category.id]: !current[category.id] }))}
                >
                  <MessageSquare size={15} fill={value.note.trim() ? "currentColor" : "none"} aria-hidden="true" />
                </button>
              </div>
              <div id={`score-details-${category.id}`} className="scorecard-details" hidden={!expanded[category.id]}>
                <label className="score-note">
                  <span className="sr-only">{category.name} notes</span>
                  <textarea
                    rows={2}
                    maxLength={2000}
                    placeholder="Interview notes (optional)"
                    value={value.note}
                    onChange={(event) => change(category.id, { note: event.target.value })}
                  />
                </label>
                {attribution(score)}
              </div>
            </fieldset>
          );
        })}
        {!!archived.length && (
          <details className="archived-scores">
            <summary>Removed categories ({archived.length})</summary>
            <p>Saved ratings are kept here for reference.</p>
            {archived.map((category) => {
              const score = scorecard.scores.find(
                (s) => s.category_id === category.id,
              )!;
              return (
                <div key={category.id} className="archived-score">
                  <strong>
                    {category.name}{" "}
                    <span>
                      {score.rating === null
                        ? "Not assessed"
                        : `${score.rating} / 10`}
                    </span>
                  </strong>
                  {score.note && <p>{score.note}</p>}
                  {attribution(score)}
                </div>
              );
            })}
          </details>
        )}
      </div>
      <footer className="scorecard-footer">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="scorecard-actions">
          <span role="status">
            {saving
              ? "Saving…"
              : saved
                ? "Scores saved."
                : dirty
                  ? "Unsaved changes"
                  : ""}
          </span>
          <button
            type="button"
            disabled={saving || loading}
            onClick={() => void reload()}
          >
            {loading ? "Loading…" : "Reload"}
          </button>
          {!!categories.length && (
            <button className="primary" disabled={disabled || !dirty}>
              {saving ? "Saving…" : "Save scores"}
            </button>
          )}
        </div>
      </footer>
    </form>
  );
}

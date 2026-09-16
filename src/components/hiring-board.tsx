"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Search,
  SlidersHorizontal,
  Zap,
  Phone,
  MessageSquare,
  ArrowUpRight,
  GripVertical,
  LoaderCircle,
} from "lucide-react";
import type { Workspace, Candidate, Activity } from "@/lib/types";
import { Avatar, Empty, when } from "./primitives";
export type Mutate = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export function HiringBoard({
  data,
  mutate,
  pendingMoves,
  onCandidate,
  onNew,
  onSignal,
}: {
  data: Workspace;
  mutate: Mutate;
  pendingMoves: Set<string>;
  onCandidate: (c: Candidate) => void;
  onNew: () => void;
  onSignal: (a: Activity) => void;
}) {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [role, setRole] = useState("");
  const [experience, setExperience] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragPoint = useRef<{
    x: number;
    y: number;
    stage: HTMLElement | null;
  } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const scroll = () => {
      const point = dragPoint.current;
      const board = boardRef.current;
      if (point && board) {
        const bounds = board.getBoundingClientRect();
        const speed = (position: number, start: number, end: number) =>
          position < start + 64
            ? -Math.min(14, (start + 64 - position) / 4)
            : position > end - 64
              ? Math.min(14, (position - end + 64) / 4)
              : 0;
        if (point.y >= bounds.top && point.y <= bounds.bottom) {
          board.scrollLeft += speed(point.x, bounds.left, bounds.right);
          const stage = point.stage;
          if (stage) {
            const rect = stage.getBoundingClientRect();
            stage.scrollTop += speed(point.y, rect.top, rect.bottom);
          }
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
    dragPoint.current = null;
  };
  const tags = useMemo(
    () => [...new Set(data.candidates.flatMap((c) => c.tags))].sort(),
    [data.candidates],
  );
  const roles = [
    ...new Set(data.candidates.map((c) => c.job_title).filter(Boolean)),
  ].sort();
  const years = [
    ...new Set(data.candidates.map((c) => c.experience).filter(Boolean)),
  ].sort();
  const candidates = data.candidates.filter(
    (c) =>
      (!tag || c.tags.includes(tag)) &&
      (!role || c.job_title === role) &&
      (!experience || c.experience === experience) &&
      [c.name, c.email, c.phone, ...c.tags]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const ids = new Set(candidates.map((c) => c.id));
  const signals = data.activities
    .filter(
      (a) =>
        ["sms", "call"].includes(a.kind) &&
        (!a.candidate_id || ids.has(a.candidate_id)),
    )
    .slice(0, 100);
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / HIRING</div>
          <h1>
            Hiring pipeline{" "}
            <span className="count">{data.candidates.length}</span>
          </h1>
          <p>Every conversation. Every next step.</p>
        </div>
        <button className="primary" onClick={onNew}>
          <Plus size={18} /> Add candidate
        </button>
      </header>
      <div className="toolbar">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Search candidates"
            placeholder="Search name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <SlidersHorizontal className="filter-icon" size={17} />
        <select
          aria-label="Filter job"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">All roles</option>
          {roles.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          aria-label="Filter experience"
          value={experience}
          onChange={(e) => setExperience(e.target.value)}
        >
          <option value="">All experience</option>
          {years.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          aria-label="Filter tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        >
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <span className="toolbar-count">{candidates.length} candidates</span>
      </div>
      <div
        className="board"
        ref={boardRef}
        onDragOver={(e) => {
          if (!dragging) return;
          dragPoint.current = {
            x: e.clientX,
            y: e.clientY,
            stage: (e.target as HTMLElement).closest<HTMLElement>(".stage"),
          };
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            dragPoint.current = null;
            setOver(null);
          }
        }}
      >
        <section className="stage signals">
          <div className="stage-heading">
            <Zap size={17} />
            <h2>Signals</h2>
            <span>{signals.filter((a) => !a.read_at).length}</span>
          </div>
          <p className="stage-description">Recent calls & messages</p>
          <div className="stage-cards">
            {signals.length ? (
              signals.map((a) => {
                const c = data.candidates.find((c) => c.id === a.candidate_id);
                return (
                  <button
                    key={a.id}
                    className={`signal-card ${!a.read_at ? "unread" : ""}`}
                    onClick={() => onSignal(a)}
                  >
                    <div className="card-person">
                      <Avatar name={c?.name || "?"} />
                      <div>
                        <strong>{c?.name || "Needs a match"}</strong>
                        <span>
                          {a.kind === "call" ? (
                            <Phone size={12} />
                          ) : (
                            <MessageSquare size={12} />
                          )}{" "}
                          {a.direction === "incoming" ? "Incoming" : "Outgoing"}{" "}
                          · {a.kind === "call" ? "Call" : "SMS"}
                        </span>
                      </div>
                      {!a.read_at && <i className="unread-dot" />}
                    </div>
                    <p>{a.body}</p>
                    <time>{when(a.occurred_at)}</time>
                  </button>
                );
              })
            ) : (
              <Empty
                title="All quiet here"
                detail="Quo calls and messages from candidates will appear here."
              />
            )}
          </div>
        </section>
        {data.stages.map((s) => {
          const list = candidates
            .filter((c) => c.stage_id === s.id)
            .sort(
              (a, b) =>
                Number(pendingMoves.has(b.id)) -
                  Number(pendingMoves.has(a.id)) ||
                b.updated_at.localeCompare(a.updated_at),
            );
          return (
            <section
              className={`stage tone-${s.color} ${over === s.id ? "drop-active" : ""}`}
              key={s.id}
              aria-label={s.name}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(s.id);
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                endDrag();
                e.currentTarget.scrollTop = 0;
                if (
                  data.candidates.some(
                    (c) => c.id === id && c.stage_id !== s.id,
                  )
                )
                  void mutate("move", { id, stage_id: s.id }).catch(() => {});
              }}
            >
              <div className="stage-heading">
                <span className="stage-dot" />
                <h2>{s.name}</h2>
                <span>{list.length}</span>
              </div>
              <p className="stage-description">
                {s.name === "Initial interview"
                  ? "First conversation"
                  : s.name === "Manager interview"
                    ? "Meet the team"
                    : s.name === "Field trial"
                      ? "Put skills into practice"
                      : s.name === "Applied"
                        ? "Ready for a first look"
                        : s.name === "Hired"
                          ? "Welcome aboard"
                          : " "}
              </p>
              <div className="stage-cards">
                {over === s.id &&
                  dragging &&
                  !list.some((c) => c.id === dragging) && (
                    <div className="drop-placeholder">Drop into {s.name}</div>
                  )}
                {list.map((c) => {
                  const last = data.activities.find(
                    (a) =>
                      a.candidate_id === c.id &&
                      ["sms", "call"].includes(a.kind),
                  );
                  return (
                    <button
                      className={`candidate-card ${dragging === c.id ? "is-dragging" : ""} ${pendingMoves.has(c.id) ? "is-saving" : ""}`}
                      key={c.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", c.id);
                        setDragging(c.id);
                      }}
                      onDragEnd={endDrag}
                      onClick={() => onCandidate(c)}
                    >
                      <div className="card-person">
                        <Avatar name={c.name} />
                        <div>
                          <strong>{c.name}</strong>
                          <span>{c.job_title || "Role not specified"}</span>
                        </div>
                        <GripVertical size={14} className="grip" />
                      </div>
                      <div className="tags">
                        {c.experience && <span>{c.experience}</span>}
                        {c.tags.slice(0, 2).map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                        {c.tags.length > 2 && <span>+{c.tags.length - 2}</span>}
                      </div>
                      <div className="card-footer">
                        {pendingMoves.has(c.id) ? (
                          <span className="card-saving">
                            <LoaderCircle size={12} className="spin" /> Saving…
                          </span>
                        ) : (
                          <span>
                            {last ? (
                              <>
                                <MessageSquare size={12} />
                                {when(last.occurred_at)}
                              </>
                            ) : (
                              <>
                                Added{" "}
                                {new Date(c.created_at).toLocaleDateString(
                                  undefined,
                                  { month: "short", day: "numeric" },
                                )}
                              </>
                            )}
                          </span>
                        )}
                        <ArrowUpRight size={14} />
                      </div>
                    </button>
                  );
                })}
                {!list.length && (
                  <div className="stage-empty">
                    {search || tag || role || experience
                      ? "No matches"
                      : "No candidates yet"}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

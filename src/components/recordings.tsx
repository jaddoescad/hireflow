"use client";
import { useEffect, useState } from "react";
import { LoaderCircle, Play, Search, Video } from "lucide-react";
import type { Candidate, Workspace } from "@/lib/types";
import type { Recording } from "@/lib/interviews";
import { recordingStatus } from "@/lib/recorder";
import { Modal } from "./primitives";
import "./recordings.css";

type Row = Recording & { interview: { title: string; candidate_id: string } };

function minutes(r: Recording) {
  return r.starts_at && r.ends_at ? Math.max(1, Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000)) : null;
}

function useRecordings(company: string, candidate?: string) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ company, ...(candidate ? { candidate } : {}) });
    fetch(`/api/recordings?${params}`, { cache: "no-store" }).then(async r => {
      const value = await r.json();
      if (!r.ok) throw new Error(value.error || "Could not load recordings.");
      if (live) setRows(value.recordings);
    }).catch(e => { if (live) { setError((e as Error).message); setRows([]); } });
    return () => { live = false; };
  }, [company, candidate]);
  return { rows, error };
}

// Saved videos stream from HireFlow storage through a short-lived link issued after a membership check.
function Player({ data, recording }: { data: Workspace; recording: Row }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ company: data.company!.id, name: recording.name });
    fetch(`/api/recordings/play?${params}`, { cache: "no-store" }).then(async r => {
      const value = await r.json();
      if (!r.ok) throw new Error(value.error || "Could not load the recording.");
      if (live) setSource(value.url);
    }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [data.company, recording.name]);
  return <>
    <div className="recording-player">{source ? <video src={source} controls autoPlay playsInline /> : !error && <p className="recording-loading"><LoaderCircle size={20} className="spin" /></p>}</div>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}

function RecordingGrid({ data, rows, onCandidate }: { data: Workspace; rows: Row[]; onCandidate?: (c: Candidate) => void }) {
  const [playing, setPlaying] = useState<Row | null>(null);
  return <>
    <div className="recording-grid">
      {rows.map(r => {
        const candidate = data.candidates.find(c => c.id === r.interview.candidate_id);
        const length = minutes(r);
        const ready = !!r.storage_key;
        return <article className="recording-card" key={r.name}>
          <button className="recording-thumb" disabled={!ready} onClick={() => setPlaying(r)} aria-label={`Play ${r.interview.title}${candidate ? ` with ${candidate.name}` : ""}`}>
            {ready ? <span className="recording-play"><Play size={22} fill="currentColor" /></span> : <span className="recording-pending"><LoaderCircle size={18} className="spin" />{recordingStatus(r)}</span>}
            {length && <span className="recording-length">{length} min</span>}
          </button>
          <div className="recording-body">
            <strong>{candidate?.name || "Candidate removed"}</strong>
            <span>{r.interview.title}</span>
            <small>{r.starts_at ? new Date(r.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Meeting recording"}</small>
            <div className="recording-links">
              {candidate && onCandidate && <button onClick={() => onCandidate(candidate)}>Candidate</button>}
            </div>
          </div>
        </article>;
      })}
    </div>
    {playing && <Modal wide title={`${data.candidates.find(c => c.id === playing.interview.candidate_id)?.name || "Recording"} · ${playing.interview.title}`} onClose={() => setPlaying(null)}>
      <Player data={data} recording={playing} />
    </Modal>}
  </>;
}

export function CandidateRecordings({ data, candidateId }: { data: Workspace; candidateId: string }) {
  const { rows, error } = useRecordings(data.company!.id, candidateId);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rows) return <p className="muted">Loading recordings…</p>;
  if (!rows.length) return <div className="recording-empty compact"><Video size={24} /><p>No recordings yet. Recorded interviews with this candidate appear here a few minutes after the call ends.</p></div>;
  return <div className="candidate-recordings"><RecordingGrid data={data} rows={rows} /></div>;
}

export function Recordings({ data, onCandidate }: { data: Workspace; onCandidate: (c: Candidate) => void }) {
  const { rows, error } = useRecordings(data.company!.id);
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const shown = rows?.filter(r => !term || r.interview.title.toLowerCase().includes(term) ||
    data.candidates.find(c => c.id === r.interview.candidate_id)?.name.toLowerCase().includes(term)) ?? [];
  const total = rows?.reduce((sum, r) => sum + (minutes(r) || 0), 0) ?? 0;
  return <>
    <header className="page-header">
      <div>
        <div className="eyebrow">WORKSPACE / RECORDINGS</div>
        <h1>Interview recordings {!!rows?.length && <span className="count">{rows.length}</span>}</h1>
        <p>{rows?.length ? `${total} minutes recorded. Watch any interview without leaving HireFlow.` : "Watch past interviews without leaving HireFlow."}</p>
      </div>
    </header>
    <div className="toolbar">
      <label className="search"><Search size={17} /><input aria-label="Search recordings" placeholder="Search candidate or interview…" value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    <div className="content-body recordings-body">
      {error && <p className="error" role="alert">{error}</p>}
      {!rows ? <p className="muted">Loading recordings…</p>
        : !rows.length ? <div className="recording-empty"><Video size={30} /><h3>No recordings yet</h3><p>Schedule an interview from Calendar with recording on. Let the recorder in when you admit the candidate, and the video appears here after the call.</p></div>
        : !shown.length ? <p className="muted">No recordings match “{search}”.</p>
        : <RecordingGrid data={data} rows={shown} onCandidate={onCandidate} />}
      {!!rows?.length && <p className="recording-note">Recordings are saved to HireFlow a few minutes after each call ends, so everyone on your team can watch.</p>}
    </div>
  </>;
}

"use client";
import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, Play, Search, Video } from "lucide-react";
import type { Candidate, Workspace } from "@/lib/types";
import { recordingPreviewUrl, recordingThumbnailUrl, type Recording } from "@/lib/interviews";
import { Modal } from "./primitives";
import "./recordings.css";

type Row = Recording & { interview: { title: string; candidate_id: string } };

function minutes(r: Recording) {
  return r.starts_at && r.ends_at ? Math.max(1, Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000)) : null;
}
function stateLabel(r: Recording) {
  return r.state === "FILE_GENERATED" ? "Ready" : r.state === "STARTED" ? "Recording now" : "Processing in Google";
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

// Saved copies stream from HireFlow storage for every member; others play from the organizer's Drive.
function Player({ data, recording }: { data: Workspace; recording: Row }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!recording.storage_key) return;
    let live = true;
    const params = new URLSearchParams({ company: data.company!.id, name: recording.name });
    fetch(`/api/recordings/play?${params}`, { cache: "no-store" }).then(async r => {
      const value = await r.json();
      if (!r.ok) throw new Error(value.error || "Could not load the recording.");
      if (live) setSource(value.url);
    }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [data.company, recording.name, recording.storage_key]);
  if (recording.storage_key) return <>
    <div className="recording-player">{source ? <video src={source} controls autoPlay playsInline /> : !error && <p className="recording-loading"><LoaderCircle size={20} className="spin" /></p>}</div>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
  const drive = recordingPreviewUrl(recording.drive_file_id);
  return <>
    {drive ? <div className="recording-player"><iframe src={drive} title="Interview recording" allow="autoplay; fullscreen" allowFullScreen /></div>
      : <p>This recording can only be opened in Google Drive.</p>}
    <p className="recording-note">Not saved to HireFlow yet, so it plays with your Google account. If Google asks for access, ask the organizer to share the file
      {recording.playback_url ? <>, or <a href={recording.playback_url} target="_blank" rel="noreferrer">open it in Google Drive</a>.</> : "."}</p>
  </>;
}

function RecordingGrid({ data, rows, onCandidate }: { data: Workspace; rows: Row[]; onCandidate?: (c: Candidate) => void }) {
  const [playing, setPlaying] = useState<Row | null>(null);
  return <>
    <div className="recording-grid">
      {rows.map(r => {
        const candidate = data.candidates.find(c => c.id === r.interview.candidate_id);
        const length = minutes(r);
        const ready = !!(r.storage_key || r.playback_url);
        const thumbnail = ready ? recordingThumbnailUrl(r.drive_file_id) : null;
        return <article className="recording-card" key={r.name}>
          <button className="recording-thumb" disabled={!ready} onClick={() => setPlaying(r)} aria-label={`Play ${r.interview.title}${candidate ? ` with ${candidate.name}` : ""}`}>
            {thumbnail && <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => e.currentTarget.remove()} />}
            {ready ? <span className="recording-play"><Play size={22} fill="currentColor" /></span> : <span className="recording-pending"><LoaderCircle size={18} className="spin" />{stateLabel(r)}</span>}
            {length && <span className="recording-length">{length} min</span>}
          </button>
          <div className="recording-body">
            <strong>{candidate?.name || "Candidate removed"}</strong>
            <span>{r.interview.title}</span>
            <small>{r.starts_at ? new Date(r.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Meeting recording"}</small>
            <div className="recording-links">
              {candidate && onCandidate && <button onClick={() => onCandidate(candidate)}>Candidate</button>}
              {!r.storage_key && r.playback_url && <a href={r.playback_url} target="_blank" rel="noreferrer">Drive <ExternalLink size={12} /></a>}
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
  if (!rows.length) return <div className="recording-empty compact"><Video size={24} /><p>No recordings yet. Recorded interviews with this candidate appear here after Google processes them.</p></div>;
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
        : !rows.length ? <div className="recording-empty"><Video size={30} /><h3>No recordings yet</h3><p>Schedule an interview from Calendar. When the organizer joins from a web browser, Google records it and the video appears here.</p></div>
        : !shown.length ? <p className="muted">No recordings match “{search}”.</p>
        : <RecordingGrid data={data} rows={shown} onCandidate={onCandidate} />}
      {!!rows?.length && <p className="recording-note">Recordings are copied from your company&apos;s Google account a few minutes after Google finishes processing them, so everyone on your team can watch.</p>}
    </div>
  </>;
}

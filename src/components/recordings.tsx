"use client";
import { useEffect, useState } from "react";
import { Play, Video } from "lucide-react";
import type { Workspace } from "@/lib/types";
import { interviewCalendarTitle, type Recording } from "@/lib/interviews";
import "./interviews.css";

type Row = Recording & { interview: { title: string; candidate_id: string } | null };

export function Recordings({data}: {data:Workspace}) {
  const cid=data.company!.id;
  const [rows,setRows]=useState<Row[]|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    let live=true;
    fetch(`/api/recordings?company=${cid}`,{cache:"no-store"}).then(async r=>{
      const value=await r.json();
      if(!r.ok) throw new Error(value.error||"Could not load recordings.");
      if(live) setRows(value.recordings);
    }).catch(e=>{if(live) {setError((e as Error).message);setRows([]);}});
    return()=>{live=false;};
  },[cid]);
  const title=(r:Row)=>r.interview?interviewCalendarTitle(r.interview.title,data.candidates.find(c=>c.id===r.interview!.candidate_id)?.name||""):"Interview";
  return <section className="interviews-page">
    <header className="interviews-heading">
      <div><h1>Recordings</h1><p>Every recorded interview, newest first.</p></div>
    </header>
    {error&&<p className="error" role="alert">{error}</p>}
    {!rows?<p>Loading recordings…</p>:rows.length===0?<div className="interview-empty"><Video size={28}/><h3>No recordings yet</h3><p>Recordings from Google Meet interviews appear here after Google processes them.</p></div>:<>
      {rows.map(r=><div className="interview-recording" key={r.name}>
        <Video size={21}/><div><strong>{title(r)}</strong><small>{r.starts_at?new Date(r.starts_at).toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}):"Meeting recording"} · {r.state==="FILE_GENERATED"?"Available in Google Drive":r.state==="STARTED"?"Recording in progress":"Processing in Google"}{r.starts_at&&r.ends_at?` · ${Math.max(1,Math.round((Date.parse(r.ends_at)-Date.parse(r.starts_at))/60000))} min`:""}</small></div>
        {r.playback_url&&<a href={r.playback_url} target="_blank" rel="noreferrer"><Play size={15}/> Watch recording</a>}
      </div>)}
      <small className="muted">Invited teammates can watch in Google Drive. Others need the organizer to share the file.</small>
    </>}
  </section>;
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Video, RefreshCw, Play, ExternalLink } from "lucide-react";
import type { Workspace } from "@/lib/types";
import { localDateTime, localInterviewWindow, type Interview, type Recording, type MeetConnection } from "@/lib/interviews";
import { Field, Modal } from "./primitives";
import "./interviews.css";

async function json(url: string, body?: unknown) {
  const response = await fetch(url, body ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {cache:"no-store"});
  const value = await response.json();
  if(!response.ok) throw new Error(value.error || "Request failed.");
  return value;
}
function dateLabel(iso:string, options:Intl.DateTimeFormatOptions) {return new Date(iso).toLocaleString(undefined,options);}
const callbackErrors:Record<string,string>={
  "wrong-account":"Choose the organizer email you entered when connecting.",
  "not-workspace":"Connect a Google Workspace account. Meet recording is not available for personal Google accounts.",
  "organizer-active":"The current organizer still has active interviews. Reconnect that account, or wait until three days after its last interview.",
  error:"Google was not connected. Check the OAuth setup and allow all requested permissions.",
};
function dayKey(date:Date) {return localDateTime(date.toISOString()).slice(0,10);}

export function Interviews({data}: {data:Workspace}) {
  const cid=data.company!.id;
  const [month,setMonth]=useState(()=>new Date(new Date().getFullYear(),new Date().getMonth(),1));
  const [sessions,setSessions]=useState<Interview[]>([]);
  const [recordings,setRecordings]=useState<Recording[]>([]);
  const [connection,setConnection]=useState<MeetConnection|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [editing,setEditing]=useState<Interview|null|undefined>();
  const [connecting,setConnecting]=useState(false);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [notice,setNotice]=useState("");
  const generation=useRef(0);
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const first=new Date(month.getFullYear(),month.getMonth(),1);
  first.setDate(first.getDate()-first.getDay());
  const end=new Date(first);end.setDate(end.getDate()+42);
  const startISO=first.toISOString(),endISO=end.toISOString();
  const load=useCallback(async()=>{
    const current=++generation.current;
    try {
      const params=new URLSearchParams({company:cid,start:startISO,end:endISO});
      const [result,status]=await Promise.all([json(`/api/interviews?${params}`),json(`/api/meet?company=${cid}`)]);
      if(current!==generation.current) return;
      setSessions(result.sessions);setRecordings(result.recordings);setConnection(status);setError("");setLoaded(true);
    } catch(e) {if(current===generation.current) {setError((e as Error).message);setLoaded(true);}}
  },[cid,startISO,endISO]);
  useEffect(()=>{
    void load();
    const timer=setInterval(()=>{if(document.visibilityState==="visible") void load();},30000);
    return()=>{clearInterval(timer);generation.current++;};
  },[load]);
  async function action(action:"sync"|"disconnect",id?:string) {
    setBusy(true);setError("");
    try {
      const result=await json("/api/meet",{company_id:cid,action,id});
      await load();
      if(result.error) setError(result.error);
      setNotice(action==="disconnect"?"Google disconnected. Existing Google events and recordings are unchanged.":
        result.state==="busy"?"Google sync is already running. Changes will appear shortly.":
        result.state==="ready"&&!result.error?"Google sync finished.":"");
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  const session=sessions.find(s=>s.id===selected);
  const admin=data.membership?.role==="admin";
  const callback=typeof window!=="undefined"?new URLSearchParams(location.search).get("meet"):null;
  const enabled=!!data.membership?.enabled;
  const sessionRecordings=session?recordings.filter(r=>r.interview_id===session.id):[];
  return <section className="interviews-page">
    <header className="interviews-heading">
      <div><h1>Interviews</h1><p>Schedule conversations. Keep every session together.</p></div>
      <button className="primary" disabled={!enabled||!connection?.connected} onClick={()=>setEditing(null)}><Plus size={17}/> Schedule interview</button>
    </header>
    {error&&<p className="error" role="alert">{error}</p>}
    {notice&&<p role="status" className="interview-notice">{notice}</p>}
    {callback==="connected"&&!notice&&<p role="status" className="interview-notice">Google Meet connected. HireFlow is syncing your interviews.</p>}
    {callback&&callback!=="connected"&&<p className="error">{callbackErrors[callback]||callbackErrors.error}</p>}
    <div className="interview-connection">
      <div><Video size={18}/><span>{connection?.connected?<><strong>{connection.organizer}</strong><small>Google Meet connected{connection.instant_updates?" · Instant updates on":""}</small></>:"Connect an organizer to schedule Google Meet interviews."}</span></div>
      <div>
        {connection?.connected&&<button disabled={busy} onClick={()=>void action("sync")}><RefreshCw size={15}/> {busy?"Syncing…":"Sync now"}</button>}
        {admin&&<button disabled={busy||!connection?.available} onClick={()=>setConnecting(true)}>{connection?.connected?"Reconnect":"Connect Google Meet"}</button>}
        {admin&&connection?.connected&&<button disabled={busy} onClick={()=>{if(confirm("Disconnect Google Meet? Existing Google events and recordings will remain, but scheduling and automatic sync will stop.")) void action("disconnect");}}>Disconnect</button>}
      </div>
    </div>
    {connection?.last_error&&<p className="error">{connection.last_error}</p>}
    {admin&&connection?.events_error&&<p className="muted">{connection.events_error}</p>}
      <div className="interview-calendar-toolbar">
        <div><button aria-label="Previous month" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}><ChevronLeft size={18}/></button>
          <button aria-label="Next month" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}><ChevronRight size={18}/></button>
          <button onClick={()=>setMonth(new Date(new Date().getFullYear(),new Date().getMonth(),1))}>Today</button>
          <h2>{month.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</h2></div><small>{timezone}</small>
      </div>
      <div className="interview-calendar-scroll"><div className="interview-calendar">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=><div className="calendar-weekday" key={d}>{d}</div>)}
        {Array.from({length:42},(_,i)=>{
          const day=new Date(first);day.setDate(first.getDate()+i);
          const key=dayKey(day);
          return <div className={`calendar-day ${day.getMonth()!==month.getMonth()?"outside":""} ${key===dayKey(new Date())?"today":""}`} key={key}>
            <span className="calendar-date">{day.getDate()}</span>
            {sessions.filter(s=>dayKey(new Date(s.starts_at))===key).map(s=><div className={`calendar-event ${s.status==="cancelled"||s.cancel_requested?"cancelled":""}`} key={s.id}>
              {s.meet_url&&s.status!=="cancelled"&&!s.cancel_requested
                ?<a href={s.meet_url} target="_blank" rel="noreferrer" title={`Join ${s.title} in Google Meet`}><span>{dateLabel(s.starts_at,{hour:"numeric",minute:"2-digit"})}</span><strong>{s.title}</strong></a>
                :<button onClick={()=>setSelected(s.id)}><span>{dateLabel(s.starts_at,{hour:"numeric",minute:"2-digit"})}</span><strong>{s.title}</strong></button>}
              <button className="event-details" onClick={()=>setSelected(s.id)} aria-label={`Details and recordings for ${s.title}`}>Details{recordings.some(r=>r.interview_id===s.id&&r.playback_url)?" · Recording":""}</button>
            </div>)}
          </div>;
        })}
      </div></div>
    <div className="interview-agenda">
      <h2>Sessions this month</h2>
      {!loaded?<p>Loading interviews…</p>:sessions.length===0?<div className="interview-empty"><CalendarDays size={28}/><h3>No interviews scheduled</h3><p>Choose a candidate and your interview team to get started.</p></div>:
        sessions.filter(s=>new Date(s.starts_at).getMonth()===month.getMonth()).map(s=><div className="interview-agenda-row" key={s.id}>
          <div><strong>{s.title}</strong><small>{dateLabel(s.starts_at,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})} · {s.status==="cancelled"?"Cancelled":s.cancel_requested?"Cancelling…":s.last_error?"Needs attention":s.synced_version<s.version?"Syncing…":"Scheduled"}</small></div>
          <div>{s.meet_url&&s.status!=="cancelled"&&!s.cancel_requested&&<a href={s.meet_url} target="_blank" rel="noreferrer"><Video size={16}/> Join Meet</a>}<button onClick={()=>setSelected(s.id)}>Details & recordings</button></div>
        </div>)}
    </div>
    {connecting&&<Modal title="Connect Google Meet" onClose={()=>setConnecting(false)}>
      <form onSubmit={async e=>{
        e.preventDefault();const email=new FormData(e.currentTarget).get("organizer");setBusy(true);setError("");
        try {const result=await json("/api/meet/connect",{company_id:cid,organizer:email});location.assign(result.url);}
        catch(e){setError((e as Error).message);setBusy(false);}
      }}>
        <p>Use the Google Workspace account that will host interviews. Invitations are sent from its calendar, and recordings stay in its Google Drive.</p>
        <Field label="Organizer email"><input type="email" name="organizer" required defaultValue={connection?.organizer||data.user.email}/></Field>
        <p className="muted">Google will ask for permission to manage calendar events and read and configure meetings. Recordings retain their Google Drive access permissions.</p>
        {error&&<p className="error">{error}</p>}
        <footer className="form-actions"><button className="primary" disabled={busy}>Continue to Google</button></footer>
      </form>
    </Modal>}
    {editing!==undefined&&<InterviewEditor key={editing?.id||"new"} data={data} session={editing} onClose={()=>setEditing(undefined)} onSave={async id=>{setEditing(undefined);setSelected(id);setNotice("Session saved. Google invitations and Meet details are syncing.");await load();}}/>}
    {session&&editing===undefined&&<Modal title={session.title} onClose={()=>setSelected(null)}>
      <div className="interview-details">
        <p><strong>{data.candidates.find(c=>c.id===session.candidate_id)?.name}</strong><br/>{dateLabel(session.starts_at,{dateStyle:"full",timeStyle:"short"})} – {dateLabel(session.ends_at,{hour:"numeric",minute:"2-digit"})}<br/>{timezone}{session.timezone!==timezone?` · scheduled in ${session.timezone}`:""}</p>
        <small>Organizer: {session.organizer}</small>
        <h3>Participants</h3>
        {session.attendees.map(a=><div className="interview-attendee" key={a.email}><span>{a.email}</span><small>{a.responseStatus==="accepted"?"Accepted":a.responseStatus==="declined"?"Declined":a.responseStatus==="tentative"?"Tentative":"Awaiting response"}</small></div>)}
        {session.last_error&&<p className="error">{session.last_error}</p>}
        {session.meeting_started_at&&<p className="muted">{session.meeting_ended_at?`Meeting held ${dateLabel(session.meeting_started_at,{hour:"numeric",minute:"2-digit"})} – ${dateLabel(session.meeting_ended_at,{hour:"numeric",minute:"2-digit"})}`:"Meeting in progress"}</p>}
        {session.synced_version<session.version&&<p role="status">{session.cancel_requested?"Cancellation":"Session changes"} syncing with Google…</p>}
        <div className="interview-detail-actions">
          {session.meet_url&&session.status!=="cancelled"&&!session.cancel_requested&&<a className="primary interview-button" href={session.meet_url} target="_blank" rel="noreferrer"><Video size={17}/> Join Google Meet <ExternalLink size={14}/></a>}
          {session.status!=="cancelled"&&!session.cancel_requested&&<button disabled={!enabled||!connection?.connected} onClick={()=>setEditing(session)}>Edit session</button>}
          <button disabled={busy||!connection?.connected} onClick={()=>void action("sync",session.id)}><RefreshCw size={15}/> Refresh session</button>
        </div>
        <h3>Recordings</h3>
        <p className="muted">{session.recording_setup==="on"?`Recording starts automatically when ${session.organizer} joins from a web browser.`:session.recording_setup==="off"?"Automatic recording is off. Record manually in Google Meet.":session.recording_setup==="pending"?"Recording setup pending.":"Start recording manually in Google Meet."}</p>
        {session.recording_error&&<p className="error">{session.recording_error}</p>}
        {sessionRecordings.map(r=><div className="interview-recording" key={r.name}>
          <Video size={21}/><div><strong>{r.starts_at?dateLabel(r.starts_at,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"Meeting recording"}</strong><small>{r.state==="FILE_GENERATED"?"Available in Google Drive":r.state==="STARTED"?"Recording in progress":"Processing in Google"}{r.starts_at&&r.ends_at?` · ${Math.max(1,Math.round((Date.parse(r.ends_at)-Date.parse(r.starts_at))/60000))} min`:""}</small></div>
          {r.playback_url&&<a href={r.playback_url} target="_blank" rel="noreferrer"><Play size={15}/> Watch recording</a>}
        </div>)}
        {!sessionRecordings.length&&<p>{session.meeting_ended_at?"No recording was made for this meeting.":"No recording yet. Recordings appear here after Google processes them."}</p>}
        {sessionRecordings.length>0&&<small>Invited teammates can watch in Google Drive. Others need the organizer to share the file.</small>}
        {session.status!=="cancelled"&&!session.cancel_requested&&<button className="danger" disabled={busy||!connection?.connected} onClick={async()=>{
          if(!confirm("Cancel this interview and notify all invited participants?")) return;
          setBusy(true);try {await json("/api/interviews",{company_id:cid,payload:{id:session.id,version:session.version,cancel:true}});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
        }}>Cancel interview</button>}
      </div>
    </Modal>}
  </section>;
}

export function InterviewEditor({data,session,candidateId,onClose,onSave}:{data:Workspace;session:Interview|null;candidateId?:string;onClose:()=>void;onSave:(id:string)=>void|Promise<void>}) {
  const [id]=useState(()=>session?.id||crypto.randomUUID());
  const [candidate,setCandidate]=useState(session?.candidate_id||candidateId||"");
  const [members,setMembers]=useState(session?.interviewer_ids||[data.user.id]);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startLocal=session?localDateTime(session.starts_at):"";
  const endLocal=session?localDateTime(session.ends_at):"";
  return <Modal title={session?"Edit interview":"Schedule interview"} onClose={onClose}><form onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError("");
    const form=new FormData(e.currentTarget);
    try {
      const window=localInterviewWindow(String(form.get("date")),String(form.get("start_time")),String(form.get("end_time")));
      const result=await json("/api/interviews",{company_id:data.company!.id,payload:{
        id,version:session?.version||0,candidate_id:candidate,title:form.get("title"),
        ...window,
        timezone,interviewer_ids:members,auto_record:form.get("auto_record")==="on",
      }});
      await onSave(result.id);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }}>
    <Field label="Candidate"><select value={candidate} required onChange={e=>setCandidate(e.target.value)}>
      <option value="">Choose a candidate</option>{data.candidates.filter(c=>c.email).map(c=><option key={c.id} value={c.id}>{c.name}{c.job_title?` · ${c.job_title}`:""}</option>)}
    </select></Field>
    <Field label="Session title"><input name="title" required maxLength={160} defaultValue={session?.title||"Interview"}/></Field>
    <div className="interview-time-grid"><Field label="Date"><input type="date" name="date" required defaultValue={startLocal.slice(0,10)}/></Field>
      <Field label="Start"><input type="time" name="start_time" required defaultValue={startLocal.slice(11)}/></Field>
      <Field label="End"><input type="time" name="end_time" required defaultValue={endLocal.slice(11)}/></Field></div>
    <small className="interview-timezone">{timezone} · An earlier end time means the next day.</small>
    <fieldset className="interviewer-picker"><legend>Internal interviewers</legend>{data.members.filter(m=>m.enabled).map(m=><label key={m.user_id}><input type="checkbox" checked={members.includes(m.user_id)} onChange={e=>setMembers(e.target.checked?[...members,m.user_id]:members.filter(id=>id!==m.user_id))}/><span>{m.email}</span></label>)}</fieldset>
    <label className="interview-checkbox"><input type="checkbox" name="auto_record" defaultChecked={session?.auto_record??true}/> Automatically record this interview</label>
    <p className="muted">Requires eligible Google Workspace recording access. Google notifies participants when recording starts. Invitations and changes are emailed to the candidate and selected interviewers.</p>
    {error&&<p className="error" role="alert">{error}</p>}
    <footer className="form-actions"><button type="button" onClick={onClose}>Back</button><button className="primary" disabled={busy||members.length===0}>{busy?"Saving…":session?"Save & notify guests":"Schedule & send invitations"}</button></footer>
  </form></Modal>;
}

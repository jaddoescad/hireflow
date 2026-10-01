import 'server-only';
import { adminDb } from './supabase/server';
import { openGmail } from './gmail-crypto';
import { firefliesQuery, sendFireflies } from './fireflies-api';
import { lateArrival } from './recorder-presence';
const recorderExpired = 'Recorder waiting period ended without a recording.';

type Presence = {recorder:boolean;humans:unknown[];firstHumanAt:string|null};
export async function dispatchFireflies(company: string, interview: string, conference: string, presence?: Presence) {
  const db = adminDb();
  let recovery: string|null = null;
  const {data:visits,error:visitError}=await db.from('hf_interview_recordings')
    .select('name,state,join_at,provider_title,meet_url,fireflies_conference,error')
    .eq('company_id',company).eq('interview_id',interview).not('provider_title','is',null)
    .order('created_at',{ascending:false}).limit(1);
  if(visitError) throw new Error('Could not check recorder status.');
  const previous=visits?.[0];
  if(previous && previous.join_at && Date.now()-Date.parse(previous.join_at)>=13*60000
    && (previous.state==='waiting' || previous.state==='failed' && previous.error===recorderExpired && presence?.humans.length && lateArrival(previous.join_at,presence.firstHumanAt))) {
    // Check both providers before declaring expiry. A failed read never authorizes another bot.
    if(presence?.recorder) return;
    const connection=await db.from('hf_fireflies_connections').select('credentials,connected_by').eq('company_id',company).maybeSingle();
    if(connection.error || !connection.data) return;
    const member=await db.from('hf_members').select('enabled,role').eq('company_id',company).eq('user_id',connection.data.connected_by).maybeSingle();
    if(member.error || !member.data?.enabled || member.data.role!=='admin') return;
    const key=openGmail<string>(connection.data.credentials);
    const active=await firefliesQuery<{active_meetings:{title:string;meeting_link:string}[]}>(key,
      `query {active_meetings{title meeting_link}}`);
    if(active.active_meetings.some(m=>m.meeting_link?.split('?')[0]===previous.meet_url)) return;
    const completed=await firefliesQuery<{transcripts:{title:string;meeting_link:string}[]}>(key,
      `query($keyword:String!){transcripts(keyword:$keyword,limit:50){title meeting_link}}`,{keyword:previous.provider_title});
    if(completed.transcripts.some(t=>t.title===previous.provider_title&&t.meeting_link?.split('?')[0]===previous.meet_url)) return;
    if(presence?.humans.length && (!previous.fireflies_conference || previous.fireflies_conference===conference) && lateArrival(previous.join_at,presence.firstHumanAt)) recovery=previous.name;
    else {
      const expired=await db.rpc('hf_fireflies_expire',{cid:company,sid:interview,visit_name:previous.name});
      if(expired.error) throw new Error('Could not save recorder timeout.');
    }
  }
  const {data, error} = await db.rpc('hf_fireflies_claim', {cid:company,sid:interview,conference_name:conference,recovery_name:recovery});
  if (error) throw new Error('Could not reserve the recorder. The connection or join limit may have changed.');
  if (!data) return;
  let state = 'waiting', problem: string|null = null;
  try { await sendFireflies(openGmail<string>(data.credentials), data.meet_url, data.title, data.duration); }
  catch(e) { state='failed'; problem=(e as Error).message; }
  const saved = await db.from('hf_interview_recordings').update({state,error:problem,updated_at:new Date().toISOString()})
    .eq('company_id',company).eq('name',data.name).eq('state','joining');
  if(saved.error) throw new Error('Could not save recorder status.');
}

type Transcript = {id:string;title:string;meeting_link:string|null;date:number;duration:number;video_url:string|null;sentences:{speaker_name:string;text:string;start_time:number;end_time:number}[]|null};
// Search by opaque visit title, then require an exact title and Meet link match. Never import other workspace meetings.
export async function syncFireflies() {
  const db=adminDb();
  const expired = await db.from('hf_interview_recordings').update({state:'failed',error:'No matching recording returned by Fireflies. Check whether the recorder was admitted.'})
    .not('provider_title','is',null).is('fireflies_id',null).lt('created_at',new Date(Date.now()-24*3600000).toISOString()).in('state',['joining','waiting','processing']);
  if(expired.error) throw new Error('Could not expire recorder visits.');
  const {data:visits,error}=await db.from('hf_interview_recordings').select('company_id,name,provider_title,meet_url,created_at')
    .not('provider_title','is',null).is('fireflies_id',null).neq('state','cancelled').gte('created_at',new Date(Date.now()-24*3600000).toISOString()).order('updated_at').limit(20);
  if(error) throw new Error('Could not load recorder visits.');
  let synced=0;
  const deadline=Date.now()+240000;
  for(const visit of visits || []) {
    if(Date.now()+25000>deadline) break;
    const connection=await db.from('hf_fireflies_connections').select('credentials,connected_by').eq('company_id',visit.company_id).maybeSingle();
    if(connection.error) throw new Error('Could not load recorder connection.');
    if(!connection.data) continue;
    const member=await db.from('hf_members').select('enabled,role').eq('company_id',visit.company_id).eq('user_id',connection.data.connected_by).maybeSingle();
    if(!member.data?.enabled||member.data.role!=='admin') continue;
    try {
      const result=await firefliesQuery<{transcripts:Transcript[]}>(openGmail<string>(connection.data.credentials),
        `query Visits($keyword:String!){transcripts(keyword:$keyword,limit:50){id title meeting_link date duration video_url sentences{speaker_name text start_time end_time}}}`,
        {keyword:visit.provider_title});
      const matches=result.transcripts.filter(t=>t.title===visit.provider_title&&t.meeting_link?.split('?')[0]===visit.meet_url);
      if(matches.length===1) {
        const t=matches[0];
        const saved=await db.from('hf_interview_recordings').update({fireflies_id:t.id,state:'done',error:null,
          starts_at:new Date(t.date).toISOString(),ends_at:new Date(t.date+t.duration*60000).toISOString(),transcript:t.sentences||[],has_video:!!t.video_url,updated_at:new Date().toISOString()})
          .eq('company_id',visit.company_id).eq('name',visit.name).is('fireflies_id',null).neq('state','cancelled');
        if(saved.error) throw new Error('Could not save transcript.');
        synced++;
      } else {
        const expired=Date.now()-Date.parse(visit.created_at)>24*3600000;
        await db.from('hf_interview_recordings').update({updated_at:new Date().toISOString(),...(expired?{state:'failed',error:'No matching recording returned by Fireflies. Check whether the recorder was admitted.'}:{})}).eq('company_id',visit.company_id).eq('name',visit.name);
      }
    } catch { await db.from('hf_interview_recordings').update({updated_at:new Date().toISOString()}).eq('company_id',visit.company_id).eq('name',visit.name); }
  }
  return synced;
}
export async function firefliesPlayback(company:string,id:string) {
  const {data,error}=await adminDb().from('hf_fireflies_connections').select('credentials').eq('company_id',company).maybeSingle();
  if(error||!data) throw new Error('Reconnect Fireflies to watch this recording.');
  const result=await firefliesQuery<{transcript:{video_url:string|null}|null}>(openGmail<string>(data.credentials),
    `query Video($id:String!){transcript(id:$id){video_url}}`,{id});
  if(!result.transcript?.video_url) throw new Error('Video unavailable. Enable video recording in Fireflies before the meeting.');
  return result.transcript.video_url;
}

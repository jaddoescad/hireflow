import test from 'node:test';
import assert from 'node:assert/strict';
import { firefliesQuery } from '../src/lib/fireflies-api';
test('Fireflies sends credentials only to the fixed API and preserves GraphQL variables',async()=>{
 let calls=0;
 const data=await firefliesQuery('synthetic-secret','query Test($id:String!){transcript(id:$id){id}}',{id:'synthetic-id'},async(url,options)=>{
  calls++; assert.equal(url,'https://api.fireflies.ai/graphql');
  assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer synthetic-secret');
  assert.deepEqual(JSON.parse(String(options?.body)).variables,{id:'synthetic-id'});
  return Response.json({data:{transcript:{id:'synthetic-id'}}});
 });
 assert.equal(calls,1); assert.deepEqual(data,{transcript:{id:'synthetic-id'}});
});
test('Fireflies rejects HTTP and GraphQL failures without leaking provider details or retrying joins',async()=>{
 for(const response of [new Response('synthetic-secret',{status:401}),Response.json({errors:[{message:'synthetic-secret'}]})]){
  let calls=0;
  await assert.rejects(()=>firefliesQuery('synthetic-secret','mutation{test}',{},async()=>{calls++;return response;}),e=> e instanceof Error&&!e.message.includes('synthetic-secret'));
  assert.equal(calls,1);
 }
 let calls=0;
 await assert.rejects(()=>firefliesQuery('synthetic-secret','mutation{test}',{},async()=>{calls++;throw Error('synthetic-secret');}),/did not confirm/);
 assert.equal(calls,1);
});

import { lateArrival, recorderPresence } from '../src/lib/recorder-presence';
test('late arrival recovery excludes attended calls and allows an expired prejoin',()=>{
 const requested='2026-09-30T13:00:00Z';const now=Date.parse('2026-09-30T13:15:00Z');
 assert.equal(lateArrival(requested,null,now),false);
 assert.equal(lateArrival(requested,'2026-09-30T12:59:00Z',now),false);
 assert.equal(lateArrival(requested,'2026-09-30T13:05:00Z',now),false);
 assert.equal(lateArrival(requested,'2026-09-30T13:11:00Z',Date.parse('2026-09-30T13:12:00Z')),false);
 assert.equal(lateArrival(requested,'2026-09-30T13:11:00Z',now),true);
});
test('a recorder alone is not human attendance; anonymous and phone guests count',()=>{
 const bot={name:'bot',anonymousUser:{displayName:'Fireflies.ai Notetaker'}};
 assert.deepEqual(recorderPresence([bot]),{recorder:true,humans:[]});
 const guests=[{name:'human',anonymousUser:{displayName:'Synthetic Candidate'}},{name:'phone',phoneUser:{displayName:'Synthetic phone guest'}}];
 assert.deepEqual(recorderPresence([bot,...guests]),{recorder:true,humans:guests});
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function recoveryWorker(options: {active?:boolean;completed?:boolean;providerFails?:boolean;firstHumanAt?:string|null;recorder?:boolean}={}) {
 const calls:string[]=[];
 const joinAt=new Date(Date.now()-20*60000).toISOString();
 const previous={name:'fireflies:scheduled:test',state:'waiting',join_at:joinAt,provider_title:'HireFlow synthetic',meet_url:'https://meet.google.com/abc-defg-hij',fireflies_conference:null,error:null};
 const db={from(table:string){
  const result=table==='hf_interview_recordings'?[previous]:table==='hf_members'?{enabled:true,role:'admin'}:{credentials:'fixture',connected_by:'admin'};
  const query:any={select(){return this},eq(){return this},not(){return this},is(){return this},order(){return this},limit(){return this},maybeSingle(){return this},update(){return this},then(resolve:any){return resolve({data:result,error:null})}};
  return query;
 },async rpc(name:string,args:any){calls.push(name+':'+(args.recovery_name||''));return {data:name==='hf_fireflies_claim' && args.conference_name!=='scheduled'?{name:'recovery',credentials:'fixture',meet_url:previous.meet_url,title:'synthetic',duration:120}:null,error:null};}};
 const exports:any={};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/fireflies.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,require:(name:string)=>({
  './supabase/server':{adminDb:()=>db},'./gmail-crypto':{openGmail:()=> 'fixture'},'./recorder-presence':{lateArrival},
  './fireflies-api':{sendFireflies:async()=>calls.push('send'),firefliesQuery:async(_:string,query:string)=>{
   calls.push(query.includes('active_meetings')?'active':'transcripts');
   if(options.providerFails)throw Error('provider failed');
   return query.includes('active_meetings')?{active_meetings:options.active?[{meeting_link:previous.meet_url}]:[]}:{transcripts:options.completed?[{title:previous.provider_title,meeting_link:previous.meet_url}]:[]};
  }},
 }[name]||{})});
 return {calls,run:()=>exports.dispatchFireflies('company','interview',options.firstHumanAt===null?'scheduled':'conferenceRecords/test',{recorder:!!options.recorder,humans:options.firstHumanAt===null?[]:[{}],firstHumanAt:options.firstHumanAt===undefined?new Date(Date.now()-2*60000).toISOString():options.firstHumanAt})};
}
test('recovery requires successful absence checks from both providers',async()=>{
 for(const options of [{active:true},{completed:true},{recorder:true}]){
  const worker=recoveryWorker(options);await worker.run();assert.ok(!worker.calls.includes('send'));assert.ok(!worker.calls.some(c=>c.startsWith('hf_fireflies_claim')));
 }
 const failed=recoveryWorker({providerFails:true});await assert.rejects(failed.run,/provider failed/);assert.ok(!failed.calls.includes('send'));
 const late=recoveryWorker();await late.run();assert.deepEqual(late.calls,['active','transcripts','hf_fireflies_claim:fireflies:scheduled:test','send']);
});
test('empty meetings expire without requesting a replacement',async()=>{
 const worker=recoveryWorker({firstHumanAt:null});await worker.run();
 assert.ok(worker.calls.some(c=>c.startsWith('hf_fireflies_expire')));
 // SQL rejects scheduled outside its two-minute window. No recovery authorization is sent.
 assert.ok(worker.calls.includes('hf_fireflies_claim:'));
 assert.ok(!worker.calls.includes('send'));
});

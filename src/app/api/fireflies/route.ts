import { NextResponse } from 'next/server';
import { z } from 'zod';
import { companyMember } from '@/lib/google';
import { adminDb } from '@/lib/supabase/server';
import { sealGmail,openGmail } from '@/lib/gmail-crypto';
import { bodyJson,sameOrigin,failure } from '@/lib/http';
import { firefliesQuery,sendFireflies } from '@/lib/fireflies-api';
import { googleMeetUrl } from '@/lib/interviews';
export async function POST(request:Request) {
  try {
    sameOrigin(request);
    const body=z.object({company_id:z.uuid(),action:z.enum(['connect','disconnect','test']),key:z.string().trim().min(15).max(1000).optional(),meeting_url:z.string().max(300).optional()}).parse(await bodyJson(request,4096));
    const {user}=await companyMember(body.company_id,true);
    const db=adminDb();
    if(body.action==='test') {
      const url=googleMeetUrl(body.meeting_url);
      if(!url) throw new Error('Enter a Google Meet link.');
      const connection=await db.rpc('hf_fireflies_test',{actor:user.id,cid:body.company_id});
      if(connection.error||!connection.data) throw new Error('Connect Fireflies first, or wait 20 minutes after your last test.');
      await sendFireflies(openGmail<string>(connection.data),url,'HireFlow integration test',15);
      return NextResponse.json({message:'Recorder requested. Admit Fireflies in Meet; joining can take a few minutes.'});
    }
    let credentials:string|null=null,account:string|null=null;
    if(body.action==='connect') {
      if(!body.key) throw new Error('Enter your Fireflies API key.');
      const result=await firefliesQuery<{user:{email:string}}>(body.key,'query{user{email}}');
      if(!result.user?.email) throw new Error('Could not verify the Fireflies account.');
      credentials=sealGmail(body.key);account=result.user.email;
    }
    const saved=await db.rpc('hf_fireflies_set',{actor:user.id,cid:body.company_id,encrypted_key:credentials,mailbox:account});
    if(saved.error) throw new Error('Could not save Fireflies connection. Check your admin access.');
    return NextResponse.json({connected:!!credentials});
  } catch(e) {return failure(e);}
}

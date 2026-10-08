import {config} from "./config.js";import type {MailRecord,SendMailRequest} from "./types.js";
const endpoint=()=>config.supabaseUrl+"/rest/v1/mail_messages";
const h=(extra:Record<string,string>={})=>({apikey:config.supabaseServiceKey,Authorization:"Bearer "+config.supabaseServiceKey,"Content-Type":"application/json",...extra});
export async function enqueue(input:SendMailRequest){
 const r=await fetch(endpoint(),{method:"POST",headers:h({Prefer:"return=representation"}),body:JSON.stringify({from_address:input.from,to_addresses:input.to,subject:input.subject,text_body:input.text??null,html_body:input.html??null,reply_to:input.reply_to??null,headers_json:input.headers??{},idempotency_key:input.idempotency_key??null,status:"queued",attempts:0})});
 if(!r.ok)throw new Error("MAIL_DB_"+r.status+" "+(await r.text()).slice(0,500)); return (await r.json() as MailRecord[])[0];
}
export async function claimNext():Promise<MailRecord|null>{
 const r=await fetch(config.supabaseUrl+"/rest/v1/rpc/claim_mail_message",{method:"POST",headers:h(),body:JSON.stringify({p_max_attempts:config.maxAttempts})});
 if(!r.ok)throw new Error("MAIL_CLAIM_"+r.status+" "+(await r.text()).slice(0,500)); return (await r.json() as MailRecord[])[0]??null;
}
async function patch(id:string,value:Record<string,unknown>){const r=await fetch(endpoint()+"?id=eq."+encodeURIComponent(id),{method:"PATCH",headers:h(),body:JSON.stringify(value)});if(!r.ok)throw new Error("MAIL_DB_PATCH_"+r.status);}
export const markSent=(id:string)=>patch(id,{status:"sent",sent_at:new Date().toISOString(),last_error:null});
export const markFailed=(id:string,error:string,retry:boolean)=>patch(id,{status:retry?"queued":"failed",last_error:error.slice(0,2000)});

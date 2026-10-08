import {mkdir,readFile,writeFile,readdir,rename,unlink} from "node:fs/promises";import {join} from "node:path";import {randomUUID} from "node:crypto";import type {QueuedMessage} from "./types.js";import {config} from "./config.js";import {createMessage,findByIdempotency} from "./db.js";
const pending=()=>join(config.queueDir,"pending"),done=()=>join(config.queueDir,"done"),failed=()=>join(config.queueDir,"failed");
export async function initQueue(){await Promise.all([mkdir(pending(),{recursive:true}),mkdir(done(),{recursive:true}),mkdir(failed(),{recursive:true})]);}
export async function enqueue(input:Omit<QueuedMessage,"id"|"created_at"|"attempts"|"status">,key?:string){
 await initQueue();
 if(key){const existing=await findByIdempotency(key);if(existing){const file=join(pending(),existing.id+".json");try{return JSON.parse(await readFile(file,"utf8")) as QueuedMessage}catch{return {...input,id:existing.id,created_at:new Date().toISOString(),attempts:0,status:existing.status as QueuedMessage["status"]};}}}
 const id=randomUUID(),msg:QueuedMessage={...input,id,created_at:new Date().toISOString(),attempts:0,status:"queued"};
 await createMessage({id,from:msg.from??config.from,to:Array.isArray(msg.to)?msg.to:[msg.to],cc:msg.cc?Array.isArray(msg.cc)?msg.cc:[msg.cc]:[],bcc:msg.bcc?Array.isArray(msg.bcc)?msg.bcc:[msg.bcc]:[],replyTo:msg.reply_to?Array.isArray(msg.reply_to)?msg.reply_to:[msg.reply_to]:[],subject:msg.subject,html:msg.html,text:msg.text,headers:msg.headers,idempotencyKey:key});
 await writeFile(join(pending(),id+".json"),JSON.stringify(msg),"utf8");return msg;
}
export async function listPending(){await initQueue();return (await readdir(pending())).filter(x=>x.endsWith(".json")&&!x.startsWith(".sending-"));}
export async function claim(file:string){const src=join(pending(),file),dst=join(pending(),".sending-"+file);try{await rename(src,dst);return dst}catch{return null}}
export async function finish(path:string,msg:QueuedMessage,ok:boolean){msg.status=ok?"sent":"failed";const target=ok?done():failed();await writeFile(join(target,msg.id+".json"),JSON.stringify(msg),"utf8");await unlink(path).catch(()=>{});}

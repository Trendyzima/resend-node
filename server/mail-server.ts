import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { SMTPTransport } from "./smtp-transport";

type EmailRequest = { from:string; to:string[]; subject:string; text?:string; html?:string; idempotency_key?:string };
const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.TESTAGRAM_MAIL_API_KEY ?? "";
const MAX_BODY = 512 * 1024;
const transport = new SMTPTransport({
  host: process.env.SMTP_HOST ?? "",
  port: Number(process.env.SMTP_PORT ?? 587),
  username: process.env.SMTP_USERNAME ?? "",
  password: process.env.SMTP_PASSWORD ?? "",
  secure: process.env.SMTP_SECURE === "true",
  from: process.env.MAIL_FROM ?? "Testagram <noreply@testagram.site>",
});

const seen = new Map<string,{id:string;at:number}>();
function json(res:ServerResponse,status:number,body:unknown){const raw=JSON.stringify(body);res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(raw);}
function auth(req:IncomingMessage){return !!API_KEY && req.headers.authorization===`Bearer ${API_KEY}`;}
async function body(req:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>MAX_BODY)throw new Error("BODY_TOO_LARGE");chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmailRequest;}
function validEmail(v:string){return /^\S+@\S+\.\S+$/.test(v);}
async function main(req:IncomingMessage,res:ServerResponse){
 if(req.method==="GET"&&req.url==="/health"){return json(res,200,{ok:true,service:"testagram-mail"});}
 if(req.method!=="POST"||req.url!=="/v1/emails")return json(res,404,{ok:false,error:"NOT_FOUND"});
 if(!auth(req))return json(res,401,{ok:false,error:"UNAUTHORIZED"});
 try{
  const input=await body(req);
  const from=String(input.from||transport.from).trim();
  const to=Array.isArray(input.to)?input.to.map(String).map(v=>v.trim()).filter(Boolean):[];
  const subject=String(input.subject||"").trim().slice(0,998);
  const text=typeof input.text==="string"?input.text:"";
  const html=typeof input.html==="string"?input.html:"";
  if(!validEmail(from.replace(/^.*<([^>]+)>.*$/,"$1"))||!to.length||to.some(v=>!validEmail(v))||!subject||(text===""&&html===""))return json(res,400,{ok:false,error:"INVALID_EMAIL"});
  const key=String(req.headers["idempotency-key"]||input.idempotency_key||"").trim();
  if(key){const existing=seen.get(key);if(existing&&Date.now()-existing.at<24*3600_000)return json(res,200,{ok:true,id:existing.id,duplicate:true});}
  const id="mail_"+randomUUID();
  await transport.send({id,from,to,subject,text,html});
  if(key)seen.set(key,{id,at:Date.now()});
  return json(res,202,{ok:true,id});
 }catch(error){const message=error instanceof Error?error.message:"MAIL_SEND_FAILED";return json(res,message==="BODY_TOO_LARGE"?413:502,{ok:false,error:message.slice(0,200)});}
}
createServer((req,res)=>void main(req,res)).listen(PORT,"127.0.0.1",()=>console.log(`testagram-mail listening on 127.0.0.1:${PORT}`));

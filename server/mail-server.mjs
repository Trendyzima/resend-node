import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const HOST = process.env.MAIL_HOST || '127.0.0.1';
const PORT = Number(process.env.MAIL_PORT || 8787);
const API_KEY = process.env.MAIL_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'noreply@testagram.site';
const HELO_NAME = process.env.MAIL_HELO_NAME || 'mail.testagram.site';
const SPOOL = process.env.MAIL_SPOOL || './var/mail-spool';
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 8;

if (!API_KEY) throw new Error('MAIL_API_KEY is required');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeHeader = (v) => typeof v === 'string' && !/[\r\n]/.test(v);
const email = (v) => typeof v === 'string' && v.length <= 320 && /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v);
const idempotency = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);

async function ensureSpool() { await fs.mkdir(SPOOL, { recursive: true, mode: 0o700 }); }
async function writeJob(job) {
  await ensureSpool();
  const tmp = path.join(SPOOL, '.' + job.id + '.tmp');
  const dst = path.join(SPOOL, job.id + '.json');
  await fs.writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
  await fs.rename(tmp, dst);
}
async function readJobs() {
  await ensureSpool();
  const names = await fs.readdir(SPOOL);
  return Promise.all(names.filter(n => n.endsWith('.json')).map(async n => {
    try { return JSON.parse(await fs.readFile(path.join(SPOOL,n),'utf8')); } catch { return null; }
  }));
}
function parseBody(req) {
  return new Promise((resolve,reject) => {
    let data=''; let size=0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('INVALID_JSON')); } });
    req.on('error', reject);
  });
}
function authorized(req) {
  const supplied = req.headers['x-testagram-mail-key'];
  if (!API_KEY || typeof supplied !== 'string') return false;
  const a=Buffer.from(supplied); const b=Buffer.from(API_KEY);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function mime(job) {
  const boundary='=_testagram_'+crypto.randomBytes(12).toString('hex');
  const headers=[
    'From: '+job.from,'To: '+job.to.join(', '),'Subject: '+job.subject,
    'Date: '+new Date(job.createdAt).toUTCString(),
    'Message-ID: <'+job.id+'@'+HELO_NAME+'>','MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="'+boundary+'"',
  ].join('\\r\\n');
  const text=String(job.text || '').replace(/\r?\n/g,'\\r\\n');
  const html=String(job.html || '').replace(/\r?\n/g,'\\r\\n');
  return headers+'\\r\\n\\r\\n--'+boundary+'\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\nContent-Transfer-Encoding: 8bit\\r\\n\\r\\n'+text+'\\r\\n--'+boundary+'\\r\\nContent-Type: text/html; charset=UTF-8\\r\\nContent-Transfer-Encoding: 8bit\\r\\n\\r\\n'+html+'\\r\\n--'+boundary+'--\\r\\n';
}
function smtp(host, job) {
  return new Promise((resolve,reject)=>{
    let socket; let secure=false; let buffer=''; let stage=0; let closed=false;
    const fail=e=>{if(!closed){closed=true;socket?.destroy();reject(e)}};
    const send=s=>socket.write(s+'\\r\\n');
    const next=(code,text)=>{
      if(stage===0){ if(code!==220) return fail(new Error('SMTP_GREETING_'+code)); send('EHLO '+HELO_NAME); stage=1; return; }
      if(stage===1){ if(code!==250) return fail(new Error('SMTP_EHLO_'+code)); if(text.includes('STARTTLS')) {send('STARTTLS'); stage=2;} else if(process.env.ALLOW_PLAINTEXT_SMTP==='true'){send('MAIL FROM:<'+job.from+'>'); stage=4;} else fail(new Error('SMTP_STARTTLS_REQUIRED')); return; }
      if(stage===2){ if(code!==220) return fail(new Error('SMTP_STARTTLS_'+code)); const old=socket; socket=tls.connect({socket:old,servername:host},()=>{secure=true; send('EHLO '+HELO_NAME); stage=3;}); socket.on('error',fail); return; }
      if(stage===3){ if(code!==250) return fail(new Error('SMTP_EHLO_TLS_'+code)); send('MAIL FROM:<'+job.from+'>'); stage=4; return; }
      if(stage===4){ if(code!==250) return fail(new Error('SMTP_MAIL_FROM_'+code)); send('RCPT TO:<'+job.to[0]+'>'); stage=5; return; }
      if(stage===5){ if(code!==250 && code!==251) return fail(new Error('SMTP_RCPT_'+code)); send('DATA'); stage=6; return; }
      if(stage===6){ if(code!==354) return fail(new Error('SMTP_DATA_'+code)); socket.write(mime(job).replace(/^\./gm,'..')+'\\r\\n.\\r\\n'); stage=7; return; }
      if(stage===7){ if(code!==250) return fail(new Error('SMTP_ACCEPT_'+code)); send('QUIT'); stage=8; return; }
      if(stage===8){ closed=true; socket.end(); resolve(); }
    };
    const onData=()=>{ buffer += socket.read()?.toString() || ''; let m; while((m=buffer.match(/^(\\d{3})([- ])([^\\r\\n]*)(?:\\r\\n|\\n)/))){ const full=m[0]; buffer=buffer.slice(full.length); if(m[2]==='-') continue; next(Number(m[1]),m[3]); } };
    const connectHost=()=>{socket=net.createConnection(25,host); socket.setTimeout(15000); socket.on('data',onData); socket.on('error',fail); socket.on('timeout',()=>fail(new Error('SMTP_TIMEOUT'))); socket.on('close',()=>{if(!closed) reject(new Error('SMTP_CLOSED'))});};
    connectHost();
  });
}
async function deliver(job) {
  const domain=job.to[0].split('@')[1];
  const mx=await dns.resolveMx(domain).catch(()=>[]);
  const hosts=mx.sort((a,b)=>a.priority-b.priority).map(x=>x.exchange);
  if(!hosts.length) hosts.push(domain);
  let last;
  for(const host of hosts.slice(0,5)){ try { await smtp(host,job); return; } catch(e){ last=e; } }
  throw last || new Error('NO_MX');
}
const active=new Set();
async function worker() {
  for(const job of (await readJobs()).filter(Boolean)){
    if(active.has(job.id) || job.status==='sent') continue;
    if(job.nextAttemptAt && Date.now()<job.nextAttemptAt) continue;
    active.add(job.id);
    try {
      job.status='sending'; job.attempts=(job.attempts||0)+1; await writeJob(job);
      await deliver(job);
      job.status='sent'; job.sentAt=new Date().toISOString(); job.error=null; await writeJob(job);
    } catch(e) {
      job.status=job.attempts>=MAX_ATTEMPTS?'failed':'queued';
      job.error=String(e?.message||e); job.nextAttemptAt=Date.now()+Math.min(60*60_000, 5000*2**Math.min(job.attempts,8)); await writeJob(job);
    } finally { active.delete(job.id); }
  }
}
setInterval(worker, 2000); worker();

const server=http.createServer(async(req,res)=>{
  try {
    if(req.method==='GET' && req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,service:'testagram-mail'}));}
    if(req.method!=='POST' || req.url!=='/v1/emails'){res.writeHead(404);return res.end();}
    if(!authorized(req)){res.writeHead(401);return res.end(JSON.stringify({error:'UNAUTHORIZED'}));}
    const body=await parseBody(req);
    const to=Array.isArray(body.to)?body.to:[body.to];
    if(!email(body.from||MAIL_FROM)||!to.length||to.length>50||!to.every(email)||!safeHeader(body.subject||'')||!String(body.text||body.html||'')){res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:'INVALID_EMAIL_REQUEST'}));}
    if(body.idempotencyKey && !idempotency(body.idempotencyKey)){res.writeHead(400);return res.end(JSON.stringify({error:'INVALID_IDEMPOTENCY_KEY'}));}
    const existing=(body.idempotencyKey && (await readJobs()).find(j=>j?.idempotencyKey===body.idempotencyKey));
    if(existing){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({id:existing.id,status:existing.status}));}
    const job={id:randomUUID(),idempotencyKey:body.idempotencyKey||null,from:body.from||MAIL_FROM,to,subject:String(body.subject),text:String(body.text||''),html:String(body.html||''),createdAt:new Date().toISOString(),status:'queued',attempts:0};
    await writeJob(job);
    res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify({id:job.id,status:'queued'}));
  } catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:String(e?.message||e)}));}
});
server.listen(PORT,HOST,()=>console.log('Testagram Mail listening on '+HOST+':'+PORT));

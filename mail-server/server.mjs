import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.MAIL_API_TOKEN || '';
const FROM_DOMAIN = (process.env.MAIL_FROM_DOMAIN || 'testagram.site').toLowerCase();
const QUEUE_DIR = process.env.MAIL_QUEUE_DIR || path.join(process.cwd(), 'data', 'mail-queue');
const MAX_BODY = 1024 * 1024;
const MAX_ATTEMPTS = Number(process.env.MAIL_MAX_ATTEMPTS || 8);
const RETRY_BASE_MS = Number(process.env.MAIL_RETRY_BASE_MS || 15000);
const RATE_PER_MIN = Number(process.env.MAIL_RATE_PER_MIN || 600);

const rate = new Map();
const idempotency = new Map();

async function ensureQueue() { await fs.mkdir(QUEUE_DIR, { recursive: true }); }
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}
function validEmail(v) { return typeof v === 'string' && /^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$/.test(v); }
function safeHeader(v) { return typeof v === 'string' && !/[\\r\\n]/.test(v); }
function dotStuff(v) { return v.replace(/^\\./gm, '..'); }
function qp(v) {
  return /^[\\x20-\\x7e]*$/.test(v) ? v : '=?UTF-8?B?' + Buffer.from(v).toString('base64') + '?=';
}
function authorized(req) {
  return Boolean(API_TOKEN) && req.headers.authorization === 'Bearer ' + API_TOKEN;
}
function limited(ip) {
  const now = Date.now();
  const b = rate.get(ip) || { at: now, n: 0 };
  if (now - b.at >= 60000) { b.at = now; b.n = 0; }
  b.n += 1; rate.set(ip, b);
  return b.n > RATE_PER_MIN;
}

function buildMessage(job) {
  const from = job.from || ('Testagram <noreply@' + FROM_DOMAIN + '>');
  if (!safeHeader(from) || job.to.some(x => !safeHeader(x)) || !safeHeader(job.subject)) throw new Error('INVALID_HEADER');
  const boundary = '=_tg_' + crypto.randomBytes(12).toString('hex');
  const id = '<' + crypto.randomUUID() + '@' + FROM_DOMAIN + '>';
  const text = job.text || '';
  const html = job.html || text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const lines = [
    'From: ' + from,
    'To: ' + job.to.join(', '),
    'Subject: ' + qp(job.subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: ' + id,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '--' + boundary + '--',
    ''
  ];
  return { raw: lines.join('\\r\\n'), messageId: id };
}

function smtp(host, from, recipients, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: 25 });
    socket.setEncoding('utf8');
    let buffer = '';
    const waiters = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('SMTP_TIMEOUT')); }, 20000);
    function fail(e) { clearTimeout(timer); socket.destroy(); reject(e); }
    function command(line) {
      return new Promise((res, rej) => {
        waiters.push({ res, rej });
        socket.write(line + '\\r\\n');
      });
    }
    function onData(chunk) {
      buffer += chunk;
      let pos;
      while ((pos = buffer.indexOf('\\r\\n')) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 2);
        if (!/^\\d{3} /.test(line)) continue;
        const waiter = waiters.shift(); if (!waiter) continue;
        if (/^[23]\\d\\d /.test(line)) waiter.res(line); else waiter.rej(new Error('SMTP_' + line));
      }
    }
    socket.on('data', onData);
    socket.on('error', fail);
    (async () => {
      try {
        await new Promise((res, rej) => waiters.push({ res, rej }));
        await command('EHLO testagram.site');
        const address = (from.match(/<([^>]+)>/) || [])[1] || from;
        await command('MAIL FROM:<' + address + '>');
        for (const to of recipients) await command('RCPT TO:<' + to + '>');
        await new Promise((res, rej) => {
          waiters.push({ res, rej }); socket.write('DATA\\r\\n');
        });
        await new Promise((res, rej) => {
          waiters.push({ res, rej }); socket.write(dotStuff(raw) + '\\r\\n.\\r\\n');
        });
        socket.write('QUIT\\r\\n');
        clearTimeout(timer); socket.destroy(); resolve();
      } catch (e) { fail(e); }
    })();
  });
}

async function deliver(job) {
  const from = (String(job.from).match(/<([^>]+)>/) || [])[1] || String(job.from);
  const byDomain = new Map();
  for (const recipient of job.to) {
    if (!validEmail(recipient)) throw new Error('INVALID_RECIPIENT');
    const domain = recipient.split('@')[1].toLowerCase();
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(recipient);
  }
  const message = buildMessage(job);
  for (const [domain, recipients] of byDomain) {
    const mx = (await dns.resolveMx(domain)).sort((a,b) => a.priority - b.priority);
    let last;
    for (const record of mx) {
      try { await smtp(record.exchange, from, recipients, message.raw); last = null; break; }
      catch (e) { last = e; }
    }
    if (last) throw last;
  }
  return { messageId: message.messageId };
}

async function enqueue(job) {
  await ensureQueue();
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(QUEUE_DIR, id + '.json'), JSON.stringify({
    id, ...job, attempts: 0, nextAttemptAt: Date.now()
  }));
  return id;
}

async function worker() {
  await ensureQueue();
  const files = (await fs.readdir(QUEUE_DIR)).filter(x => x.endsWith('.json')).slice(0, 20);
  for (const file of files) {
    const p = path.join(QUEUE_DIR, file);
    let job;
    try { job = JSON.parse(await fs.readFile(p, 'utf8')); } catch { await fs.rm(p, { force: true }); continue; }
    if (job.nextAttemptAt > Date.now()) continue;
    try {
      const result = await deliver(job);
      await fs.writeFile(p.replace('.json', '.sent.json'), JSON.stringify({ ...job, status: 'sent', result, sentAt: new Date().toISOString() }));
      await fs.rm(p, { force: true });
    } catch (e) {
      job.attempts += 1;
      if (job.attempts >= MAX_ATTEMPTS) {
        await fs.writeFile(p.replace('.json', '.failed.json'), JSON.stringify({ ...job, status: 'failed', error: String(e?.message || e), failedAt: new Date().toISOString() }));
        await fs.rm(p, { force: true });
      } else {
        job.nextAttemptAt = Date.now() + RETRY_BASE_MS * Math.min(64, 2 ** (job.attempts - 1));
        await fs.writeFile(p, JSON.stringify(job));
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'testagram-mail', queue: QUEUE_DIR });
    if (req.method !== 'POST' || url.pathname !== '/emails') return json(res, 404, { error: 'NOT_FOUND' });
    if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
    if (limited(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'RATE_LIMITED' });
    const key = String(req.headers['idempotency-key'] || '').trim();
    if (!key) return json(res, 400, { error: 'IDEMPOTENCY_KEY_REQUIRED' });
    if (idempotency.has(key)) return json(res, 200, idempotency.get(key));
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return json(res, 413, { error: 'BODY_TOO_LARGE' });
    }
    const input = JSON.parse(body);
    const to = Array.isArray(input.to) ? input.to.map(String) : [String(input.to || '')];
    if (!to.length || to.length > 100 || to.some(x => !validEmail(x))) return json(res, 400, { error: 'INVALID_RECIPIENTS' });
    if (!input.subject || !safeHeader(String(input.subject))) return json(res, 400, { error: 'INVALID_SUBJECT' });
    if (!input.html && !input.text) return json(res, 400, { error: 'CONTENT_REQUIRED' });
    const job = {
      from: String(input.from || ('Testagram <noreply@' + FROM_DOMAIN + '>')),
      to, subject: String(input.subject),
      html: input.html ? String(input.html) : '',
      text: input.text ? String(input.text) : '',
      createdAt: new Date().toISOString()
    };
    const id = await enqueue(job);
    const result = { id, status: 'queued' };
    idempotency.set(key, result);
    return json(res, 202, result);
  } catch (e) {
    return json(res, 400, { error: String(e?.message || e) });
  }
});

await ensureQueue();
server.listen(PORT, HOST, () => console.log('testagram-mail listening on ' + HOST + ':' + PORT));
setInterval(() => worker().catch(e => console.error('[mail-worker]', e)), 5000);
await worker();

// SomaPrompt teleprompter server.
// One process: static site, JSON API, live sync over WebSocket, AI proxy.
// Storage: SQLite (built into Node 22.5+). Only dependency: ws.
import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, 'public');
const PORT = +process.env.PORT || 8080;
const DATA = process.env.CUE_DATA || path.join(DIR, 'data');
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.CUE_AI_MODEL || 'claude-sonnet-5-5';
const AI_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
const FORCE_SECURE = process.env.CUE_SECURE === '1';
const ALLOW_SIGNUP = process.env.CUE_ALLOW_SIGNUP !== '0';
const SESSION_DAYS = 30;
const MAX_DOC = 256 * 1024;
const MAX_DOCS_PER_COLL = 2000;

fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'cue.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL,
  workspace TEXT NOT NULL REFERENCES workspaces(id), created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(coll, id));
CREATE TABLE IF NOT EXISTS takes(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, script TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  dur REAL NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS takes_owner ON takes(owner);
CREATE INDEX IF NOT EXISTS takes_ws ON takes(workspace, shared);
`);
// Older databases: add the captions columns if they are missing.
for (const col of ['vtt', 'srt']) { if (!db.prepare('PRAGMA table_info(takes)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE takes ADD COLUMN ${col} TEXT`); }
const TAKES_DIR = path.join(DATA, 'takes');
fs.mkdirSync(TAKES_DIR, { recursive: true });
const TAKES_QUOTA = Math.round((+process.env.CUE_TAKES_QUOTA_GB || 20) * 1e9);
const MAX_CHUNK = 16 * 1024 * 1024;

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users(id,email,name,pass,workspace,created) VALUES(?,?,?,?,?,?)'),
  setUserWs: db.prepare('UPDATE users SET workspace = ? WHERE id = ?'),
  insertWs: db.prepare('INSERT INTO workspaces(id,name,code,created) VALUES(?,?,?,?)'),
  wsById: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
  wsByCode: db.prepare('SELECT * FROM workspaces WHERE code = ?'),
  renameWs: db.prepare('UPDATE workspaces SET name = ? WHERE id = ?'),
  recodeWs: db.prepare('UPDATE workspaces SET code = ? WHERE id = ?'),
  members: db.prepare('SELECT id, name FROM users WHERE workspace = ? ORDER BY created'),
  insertSession: db.prepare('INSERT INTO sessions(token,user,expires) VALUES(?,?,?)'),
  sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user WHERE s.token = ? AND s.expires > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
  docs: db.prepare('SELECT id, data FROM docs WHERE coll = ? ORDER BY id'),
  docExists: db.prepare('SELECT 1 FROM docs WHERE coll = ? AND id = ?'),
  docCount: db.prepare('SELECT COUNT(*) AS n FROM docs WHERE coll = ?'),
  upsertDoc: db.prepare('INSERT INTO docs(coll,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data = excluded.data, updated = excluded.updated'),
  deleteDoc: db.prepare('DELETE FROM docs WHERE coll = ? AND id = ?'),
  insertTake: db.prepare('INSERT INTO takes(id,owner,workspace,name,script,mime,created) VALUES(?,?,?,?,?,?,?)'),
  take: db.prepare('SELECT * FROM takes WHERE id = ?'),
  takeSize: db.prepare('UPDATE takes SET size = ? WHERE id = ?'),
  takeFinish: db.prepare('UPDATE takes SET complete = 1, dur = ? WHERE id = ?'),
  takeShare: db.prepare('UPDATE takes SET shared = ?, workspace = ? WHERE id = ?'),
  takeDelete: db.prepare('DELETE FROM takes WHERE id = ?'),
  takesUsed: db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM takes WHERE owner = ?'),
  takesList: db.prepare(`SELECT t.*, u.name AS byName FROM takes t JOIN users u ON u.id = t.owner
    WHERE t.owner = ? OR (t.shared = 1 AND t.workspace = ?) ORDER BY t.created DESC LIMIT 500`),
  takesOf: db.prepare('SELECT id FROM takes WHERE owner = ?'),
  takeCaps: db.prepare('UPDATE takes SET vtt = ?, srt = ? WHERE id = ?'),
};

/* ---------- helpers ---------- */
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHA[b % CODE_ALPHA.length]).join('');
function uniqueCode() { for (;;) { const c = newCode(); if (!q.wsByCode.get(c)) return c; } }

function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}
function checkPass(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1') return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

const buckets = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); q.purgeSessions.run(now); }, 10 * 60 * 1000).unref();

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isSecure = (req) => FORCE_SECURE || req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
function userFrom(req) {
  const t = cookies(req).cue_s;
  return t ? q.sessionUser.get(sha(t), Date.now()) || null : null;
}
function startSession(req, res, userId) {
  const token = rid(32);
  q.insertSession.run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `cue_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`);
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
async function readJson(req, limit = 1 << 20) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}
function me(u) {
  const ws = q.wsById.get(u.workspace);
  return { id: u.id, name: u.name, email: u.email, team: { id: ws.id, name: ws.name, code: ws.code, members: q.members.all(ws.id).map((m) => ({ id: m.id, name: m.name })) } };
}
function newWorkspace(name) {
  const id = rid(9);
  q.insertWs.run(id, name.slice(0, 60), uniqueCode(), Date.now());
  return id;
}
const sameOrigin = (req) => {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

/* ---------- API ---------- */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
async function api(req, res, url) {
  const p = url.pathname;
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused.' });

  if (p === '/api/config' && req.method === 'GET') return send(res, 200, { ai: !!AI_KEY, signup: ALLOW_SIGNUP });

  if (p === '/api/signup' && req.method === 'POST') {
    if (!ALLOW_SIGNUP) return send(res, 403, { error: 'New accounts are switched off on this server.' });
    if (!allow('signup:' + clientIp(req), 10, 3600e3)) return send(res, 429, { error: 'Too many sign-ups from this network. Try again later.' });
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!EMAIL.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (!name || name.length > 60) return send(res, 400, { error: 'Enter your name (up to 60 characters).' });
    if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'Use a password of at least 8 characters.' });
    if (q.userByEmail.get(email)) return send(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
    const wsId = newWorkspace(`${name.split(' ')[0]}'s team`);
    const id = rid(12);
    q.insertUser.run(id, email, name, hashPass(pw), wsId, Date.now());
    startSession(req, res, id);
    return send(res, 200, me(q.userById.get(id)));
  }

  if (p === '/api/login' && req.method === 'POST') {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!allow('login:' + clientIp(req), 20, 600e3) || !allow('login:' + email, 10, 600e3)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    const u = q.userByEmail.get(email);
    if (!u || !checkPass(String(b.password || ''), u.pass)) return send(res, 401, { error: 'That email and password don’t match.' });
    startSession(req, res, u.id);
    return send(res, 200, me(u));
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const t = cookies(req).cue_s;
    if (t) q.deleteSession.run(sha(t));
    res.setHeader('Set-Cookie', `cue_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
    return send(res, 200, { ok: true });
  }

  const u = userFrom(req);
  if (p === '/api/session' && req.method === 'GET') return send(res, 200, { me: u ? me(u) : null });
  if (!u) return send(res, 401, { error: 'Sign in first.' });

  if (p === '/api/me' && req.method === 'GET') return send(res, 200, me(u));

  if (p === '/api/team/join' && req.method === 'POST') {
    if (!allow('join:' + u.id, 20, 3600e3)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    const b = await readJson(req);
    const ws = q.wsByCode.get(String(b.code || '').trim().toUpperCase());
    if (!ws) return send(res, 404, { error: 'No team has that invite code.' });
    q.setUserWs.run(ws.id, u.id);
    kickTeamSubs(u.id);
    return send(res, 200, me(q.userById.get(u.id)));
  }
  if (p === '/api/team/leave' && req.method === 'POST') {
    const wsId = newWorkspace(`${u.name.split(' ')[0]}'s team`);
    q.setUserWs.run(wsId, u.id);
    kickTeamSubs(u.id);
    return send(res, 200, me(q.userById.get(u.id)));
  }
  if (p === '/api/team/rename' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name || name.length > 60) return send(res, 400, { error: 'Team names are 1 to 60 characters.' });
    q.renameWs.run(name, u.workspace);
    return send(res, 200, me(u));
  }
  if (p === '/api/team/new-code' && req.method === 'POST') {
    q.recodeWs.run(uniqueCode(), u.workspace);
    return send(res, 200, me(u));
  }

  if (p === '/api/profiles' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
    const out = {};
    for (const id of ids) {
      const x = q.userById.get(id);
      out[id] = x && (x.workspace === u.workspace || x.id === u.id) ? { name: x.name } : { name: '' };
    }
    return send(res, 200, out);
  }

  if (p === '/api/ai' && req.method === 'POST') return aiProxy(req, res, u);

  if (p.startsWith('/api/takes')) return takesApi(req, res, url, u);

  return send(res, 404, { error: 'Not found.' });
}

/* ---------- takes library ---------- */
const MIME_OK = /^(video|audio)\/(mp4|webm|ogg|x-matroska)(;[\w=.,\s-]*)?$/;
const takeFile = (id) => path.join(TAKES_DIR, id + '.bin');
const canSee = (t, u) => t && (t.owner === u.id || (t.shared && t.workspace === u.workspace));
const takeOut = (t, u) => ({ id: t.id, name: t.name, script: t.script, mime: t.mime, size: t.size, dur: t.dur, complete: !!t.complete, shared: !!t.shared, created: t.created, by: t.byName || '', mine: t.owner === u.id, captions: !!t.vtt });
async function readRaw(req, limit) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Chunk too large.'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function takesApi(req, res, url, u) {
  const p = url.pathname;
  if (p === '/api/takes' && req.method === 'GET') {
    return send(res, 200, { used: q.takesUsed.get(u.id).n, quota: TAKES_QUOTA, takes: q.takesList.all(u.id, u.workspace).map((t) => takeOut(t, u)) });
  }
  if (p === '/api/takes' && req.method === 'POST') {
    const b = await readJson(req);
    const mime = String(b.mime || '').toLowerCase().split(';')[0].trim();
    if (!MIME_OK.test(mime)) return send(res, 400, { error: 'Unsupported recording format.' });
    if (q.takesUsed.get(u.id).n >= TAKES_QUOTA) return send(res, 413, { error: 'Your takes library is full. Delete some takes to upload more.' });
    const id = rid(12);
    fs.writeFileSync(takeFile(id), '');
    q.insertTake.run(id, u.id, u.workspace, String(b.name || 'Take').slice(0, 120), String(b.script || '').slice(0, 120), mime, Date.now());
    return send(res, 200, { id });
  }
  const m = /^\/api\/takes\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/.exec(p);
  if (!m) return send(res, 404, { error: 'Not found.' });
  const t = q.take.get(m[1]);
  const act = m[2] || '';
  if (!canSee(t, u)) return send(res, 404, { error: 'Take not found.' });

  if (act === '/file' && (req.method === 'GET' || req.method === 'HEAD')) {
    let st; try { st = fs.statSync(takeFile(t.id)); } catch { return send(res, 404, { error: 'File missing.' }); }
    const ext = t.mime.includes('mp4') ? (t.mime.startsWith('audio') ? 'm4a' : 'mp4') : 'webm';
    const fname = (t.name.replace(/[^\w .-]+/g, '').trim() || 'take').replace(/\.(mp4|m4a|webm)$/i, '') + '.' + ext;
    const headers = { 'Content-Type': t.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${url.searchParams.has('dl') ? 'attachment' : 'inline'}; filename="${fname}"` };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size) {
      let start = range[1] === '' ? Math.max(0, st.size - +range[2]) : +range[1];
      let end = range[1] !== '' && range[2] !== '' ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(takeFile(t.id), { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(takeFile(t.id)).pipe(res);
  }
  if (act === '/captions' && req.method === 'GET') {
    const fmt = url.searchParams.get('format') === 'srt' ? 'srt' : 'vtt';
    const body = t[fmt];
    if (!body) return send(res, 404, { error: 'This take has no captions.' });
    const base = (t.name.replace(/[^\w .-]+/g, '').trim() || 'take').replace(/\.(mp4|m4a|webm)$/i, '');
    res.writeHead(200, { 'Content-Type': fmt === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff',
      ...(url.searchParams.has('dl') ? { 'Content-Disposition': `attachment; filename="${base}.${fmt}"` } : {}) });
    return res.end(body);
  }
  if (t.owner !== u.id) return send(res, 403, { error: 'Only the person who recorded this take can change it.' });
  if (act === '/captions' && req.method === 'POST') {
    const b = await readJson(req, 2 << 20);
    const vtt = String(b.vtt || ''), srt = String(b.srt || '');
    if (!vtt.startsWith('WEBVTT') || vtt.length > 1e6 || srt.length > 1e6) return send(res, 400, { error: 'Captions are not valid.' });
    q.takeCaps.run(vtt, srt, t.id);
    return send(res, 200, { ok: true });
  }

  if (act === '/chunk' && req.method === 'PUT') {
    if (t.complete) return send(res, 409, { error: 'This take is already finished.', size: t.size });
    const offset = +url.searchParams.get('offset');
    const buf = await readRaw(req, MAX_CHUNK);
    const file = takeFile(t.id);
    const size = fs.statSync(file).size;
    if (offset + buf.length <= size) return send(res, 200, { size }); // already stored (a retry)
    if (offset !== size) return send(res, 409, { error: 'Out of order.', size });
    if (q.takesUsed.get(u.id).n + buf.length > TAKES_QUOTA) return send(res, 413, { error: 'Your takes library is full. Delete some takes to upload more.' });
    fs.appendFileSync(file, buf);
    q.takeSize.run(size + buf.length, t.id);
    return send(res, 200, { size: size + buf.length });
  }
  if (act === '/finish' && req.method === 'POST') {
    const b = await readJson(req);
    q.takeFinish.run(Math.max(0, Math.min(+b.dur || 0, 86400)), t.id);
    return send(res, 200, { ok: true });
  }
  if (act === '/share' && req.method === 'POST') {
    const b = await readJson(req);
    q.takeShare.run(b.shared ? 1 : 0, u.workspace, t.id);
    return send(res, 200, { ok: true });
  }
  if (act === '/delete' && req.method === 'POST') {
    q.takeDelete.run(t.id);
    fs.rmSync(takeFile(t.id), { force: true });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found.' });
}

/* ---------- AI proxy (streams plain text) ---------- */
async function aiProxy(req, res, u) {
  if (!AI_KEY) return send(res, 503, { error: 'The script assistant is not set up on this server.' });
  if (!allow('ai:' + u.id, 60, 3600e3)) return send(res, 429, { error: 'rate_limited' });
  const b = await readJson(req);
  const prompt = String(b.prompt || '');
  if (!prompt || prompt.length > 60000) return send(res, 400, { error: 'Prompt missing or too long.' });
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  let up;
  try {
    up = await fetch(AI_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, stream: true, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch { return send(res, 502, { error: 'Could not reach the AI service.' }); }
  if (!up.ok || !up.body) {
    const t = await up.text().catch(() => '');
    console.error('AI error', up.status, t.slice(0, 300));
    return send(res, up.status === 429 ? 429 : 502, { error: up.status === 429 ? 'rate_limited' : 'The AI service returned an error.' });
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const dec = new TextDecoder(); let buf = '';
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text);
        } catch { /* ignore keep-alives */ }
      }
    }
  } catch { /* client went away */ }
  res.end();
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), fullscreen=(self)',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const body = await readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600', ...SEC });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found', SEC);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    if (!e.status) console.error(e);
  }
});

/* ---------- live sync + rooms over WebSocket ---------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const conns = new Set();
const rooms = new Map(); // roomKey -> Set(conn)

function resolveColl(conn, p) {
  if (p === 'team') { const u = q.userById.get(conn.user.id); return u ? 'w:' + u.workspace : null; }
  const m = /^data\/users\/([A-Za-z0-9_-]+)$/.exec(p);
  if (m && m[1] === conn.user.id) return 'u:' + conn.user.id;
  return null;
}
const out = (conn, msg) => { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg)); };
function snapshot(coll) { return q.docs.all(coll).map((r) => ({ id: r.id, data: JSON.parse(r.data) })); }
function broadcastColl(coll) {
  const docs = snapshot(coll);
  for (const c of conns) for (const [qid, k] of c.subs) if (k === coll) out(c, { t: 'snap', q: qid, docs });
}
function kickTeamSubs(userId) {
  // A user changed team: their open "team" subscriptions point at the old team. Tell those tabs to reload.
  for (const c of conns) if (c.user.id === userId) out(c, { t: 'reload' });
}
function roomPeers(key) {
  const set = rooms.get(key); if (!set) return;
  const ids = [...set].map((c) => c.id);
  const name = key.split(':').slice(2).join(':');
  for (const c of set) out(c, { t: 'peers', room: name, peers: ids });
}
function leaveRoom(conn, name) {
  const key = `r:${conn.user.id}:${name}`;
  const set = rooms.get(key);
  if (set) { set.delete(conn); if (!set.size) rooms.delete(key); else roomPeers(key); }
  conn.rooms.delete(name);
}
const ID_RE = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;

function onMessage(conn, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (!allow('ws:' + conn.id, 120, 1000)) return out(conn, { t: 'err', r: m.r, code: 'resource_exhausted' });
  const fail = (code) => out(conn, { t: 'err', r: m.r, code });
  switch (m.t) {
    case 'sub': {
      const coll = resolveColl(conn, String(m.path));
      if (!coll) return out(conn, { t: 'suberr', q: m.q, code: 'invalid_argument' });
      conn.subs.set(m.q, coll);
      return out(conn, { t: 'snap', q: m.q, docs: snapshot(coll) });
    }
    case 'unsub': conn.subs.delete(m.q); return;
    case 'set': {
      const coll = resolveColl(conn, String(m.path));
      if (!coll || !ID_RE.test(String(m.id)) || !m.data || typeof m.data !== 'object' || Array.isArray(m.data)) return fail('invalid_argument');
      const json = JSON.stringify(m.data);
      if (json.length > MAX_DOC) return fail('invalid_argument');
      if (!q.docExists.get(coll, m.id) && q.docCount.get(coll).n >= MAX_DOCS_PER_COLL) return fail('quota_exceeded');
      q.upsertDoc.run(coll, m.id, json, Date.now());
      out(conn, { t: 'ok', r: m.r });
      return broadcastColl(coll);
    }
    case 'del': {
      const coll = resolveColl(conn, String(m.path));
      if (!coll || !ID_RE.test(String(m.id))) return fail('invalid_argument');
      q.deleteDoc.run(coll, m.id);
      out(conn, { t: 'ok', r: m.r });
      return broadcastColl(coll);
    }
    case 'join': {
      const name = String(m.room);
      if (!ROOM_RE.test(name) || conn.rooms.size >= 16) return fail('invalid_argument');
      const key = `r:${conn.user.id}:${name}`;
      if (!rooms.has(key)) rooms.set(key, new Set());
      rooms.get(key).add(conn); conn.rooms.add(name);
      out(conn, { t: 'ok', r: m.r });
      return roomPeers(key);
    }
    case 'leave': leaveRoom(conn, String(m.room)); return out(conn, { t: 'ok', r: m.r });
    case 'emit': {
      const name = String(m.room), topic = String(m.topic);
      if (!conn.rooms.has(name) || !TOPIC_RE.test(topic)) return fail('invalid_argument');
      if (JSON.stringify(m.data ?? null).length > 4096) return fail('invalid_argument');
      const set = rooms.get(`r:${conn.user.id}:${name}`);
      for (const c of set || []) out(c, { t: 'msg', room: name, topic, data: m.data ?? null, from: conn.id });
      return out(conn, { t: 'ok', r: m.r });
    }
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const u = url.pathname === '/ws' && sameOrigin(req) ? userFrom(req) : null;
  if (!u) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = { ws, user: { id: u.id }, id: rid(8), subs: new Map(), rooms: new Set(), alive: true };
    conns.add(conn);
    out(conn, { t: 'hello', conn: conn.id });
    ws.on('message', (d) => onMessage(conn, d.toString()));
    ws.on('pong', () => { conn.alive = true; });
    ws.on('close', () => { conns.delete(conn); for (const r of [...conn.rooms]) leaveRoom(conn, r); });
  });
});
setInterval(() => {
  for (const c of conns) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch {} }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`SomaPrompt is running on http://localhost:${PORT}`);
  console.log(`Data: ${DATA} · AI assistant: ${AI_KEY ? 'on (' + AI_MODEL + ')' : 'off (set ANTHROPIC_API_KEY)'}`);
});

const shutdown = () => { server.close(); for (const c of conns) c.ws.close(1001); try { db.close(); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

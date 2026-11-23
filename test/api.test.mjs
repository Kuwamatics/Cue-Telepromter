// API and live-sync tests. Run with: npm test
// Starts a throwaway server on a free port with a temporary data folder.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'cue-test-'));
let proc;

before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CUE_DATA: dataDir, ANTHROPIC_API_KEY: '' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(BASE + p, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const live = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie, origin: BASE } });
    const inbox = []; const waiters = [];
    ws.on('message', (d) => { const m = JSON.parse(d); inbox.push(m); waiters.splice(0).forEach((w) => w()); });
    ws.on('open', () => resolve({
      ws, send: (m) => ws.send(JSON.stringify(m)),
      async next(pred, ms = 2000) {
        const end = Date.now() + ms;
        for (;;) {
          const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0];
          if (Date.now() > end) return null;
          await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
        }
      },
    }));
    ws.on('unexpected-response', (_, res) => reject(new Error('ws ' + res.statusCode)));
    ws.on('error', reject);
  });
  return { call, live, cookie: () => cookie };
}

const A = client(), B = client();
let meA, meB;

test('sign-up, sign-in and session', async () => {
  assert.equal((await A.call('/api/me')).status, 401);
  assert.equal((await A.call('/api/signup', { name: 'Amina Otieno', email: 'amina@example.com', password: 'short' })).status, 400);
  const r = await A.call('/api/signup', { name: 'Amina Otieno', email: 'Amina@Example.com', password: 'correct horse' });
  assert.equal(r.status, 200); meA = r.body;
  assert.equal(meA.email, 'amina@example.com');
  assert.match(meA.team.code, /^[A-Z2-9]{6}$/);
  assert.equal((await A.call('/api/signup', { name: 'X', email: 'amina@example.com', password: 'whatever1' })).status, 409);
  assert.equal((await B.call('/api/login', { email: 'amina@example.com', password: 'wrong pass' })).status, 401);
  meB = (await B.call('/api/signup', { name: 'Brian Mwangi', email: 'brian@example.com', password: 'another pass' })).body;
  assert.equal((await A.call('/api/me')).body.id, meA.id);
});

test('cross-site POST is refused', async () => {
  const r = await fetch(BASE + '/api/team/new-code', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('websocket needs a session', async () => {
  await assert.rejects(client().live(), /401/);
});

test('personal scripts sync live and stay private', async () => {
  const a1 = await A.live(), a2 = await A.live(), b = await B.live();
  const mine = 'data/users/' + meA.id;
  a2.send({ t: 'sub', q: 1, path: mine });
  assert.deepEqual((await a2.next((m) => m.t === 'snap')).docs, []);
  a1.send({ t: 'set', r: 1, path: mine, id: 's1', data: { title: 'Opening', body: 'Hello' } });
  assert.ok(await a1.next((m) => m.t === 'ok' && m.r === 1));
  const s = await a2.next((m) => m.t === 'snap');
  assert.equal(s.docs[0].data.title, 'Opening');
  b.send({ t: 'sub', q: 9, path: mine });
  assert.equal((await b.next((m) => m.t === 'suberr')).code, 'invalid_argument');
  b.send({ t: 'set', r: 2, path: mine, id: 'evil', data: { x: 1 } });
  assert.equal((await b.next((m) => m.t === 'err')).code, 'invalid_argument');
  [a1, a2, b].forEach((c) => c.ws.close());
});

test('team scripts are shared after joining with the invite code', async () => {
  assert.equal((await B.call('/api/team/join', { code: 'NOPE00' })).status, 404);
  const j = await B.call('/api/team/join', { code: meA.team.code.toLowerCase() });
  assert.equal(j.status, 200);
  assert.equal(j.body.team.id, meA.team.id);
  assert.deepEqual(j.body.team.members.map((m) => m.name), ['Amina Otieno', 'Brian Mwangi']);
  const a = await A.live(), b = await B.live();
  a.send({ t: 'sub', q: 1, path: 'team' }); await a.next((m) => m.t === 'snap');
  b.send({ t: 'set', r: 1, path: 'team', id: 't1', data: { title: 'Launch video', body: 'Meet Cue.', by: meB.id } });
  const s = await a.next((m) => m.t === 'snap' && m.docs.length);
  assert.equal(s.docs[0].data.title, 'Launch video');
  const prof = await A.call('/api/profiles?ids=' + meB.id);
  assert.equal(prof.body[meB.id].name, 'Brian Mwangi');
  a.ws.close(); b.ws.close();
});

test('phone remote rooms reach only the same account', async () => {
  const prompter = await A.live(), phone = await A.live(), stranger = await B.live();
  for (const [c, r] of [[prompter, 1], [phone, 2], [stranger, 3]]) c.send({ t: 'join', r, room: 'cue-k7p2' });
  assert.ok(await prompter.next((m) => m.t === 'peers' && m.peers.length === 2));
  stranger.send({ t: 'emit', r: 4, room: 'cue-k7p2', topic: 'ctl', data: { a: 'toggle' } });
  phone.send({ t: 'emit', r: 5, room: 'cue-k7p2', topic: 'ctl', data: { a: 'next' } });
  const got = await prompter.next((m) => m.t === 'msg');
  assert.equal(got.data.a, 'next');
  assert.equal(await prompter.next((m) => m.t === 'msg', 400), null);
  [prompter, phone, stranger].forEach((c) => c.ws.close());
});

test('assistant is off without an API key', async () => {
  assert.equal((await A.call('/api/config')).body.ai, false);
  assert.equal((await A.call('/api/ai', { prompt: 'hi' })).status, 503);
});

test('static files carry camera-friendly security headers', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.equal((await fetch(BASE + '/..%2fserver.js')).status, 403);
});

test('takes upload in chunks, survive retries, stream with ranges and share with the team', async () => {
  const put = (c, id, offset, buf) => fetch(`${BASE}/api/takes/${id}/chunk?offset=${offset}`, { method: 'PUT', headers: { cookie: c.cookie(), 'content-type': 'application/octet-stream', origin: BASE }, body: buf });
  assert.equal((await A.call('/api/takes', { name: 'x', mime: 'text/html' })).status, 400);
  const { id } = (await A.call('/api/takes', { name: 'Opening take 1.mp4', mime: 'video/mp4;codecs=avc1', script: 'Opening' })).body;
  const one = Buffer.alloc(1000, 1), two = Buffer.alloc(500, 2);
  assert.equal((await (await put(A, id, 0, one)).json()).size, 1000);
  assert.equal((await (await put(A, id, 0, one)).json()).size, 1000, 'a retried chunk is not stored twice');
  assert.equal((await put(A, id, 5000, two)).status, 409, 'a gap is refused');
  assert.equal((await (await put(A, id, 1000, two)).json()).size, 1500);
  assert.equal((await put(B, id, 1500, two)).status, 404, 'others cannot see an unshared take');
  assert.equal((await A.call(`/api/takes/${id}/finish`, { dur: 12.5 })).status, 200);
  const list = (await A.call('/api/takes')).body;
  assert.equal(list.takes[0].size, 1500); assert.equal(list.takes[0].complete, true); assert.equal(list.used, 1500);
  const r = await fetch(`${BASE}/api/takes/${id}/file`, { headers: { cookie: A.cookie(), range: 'bytes=990-1009' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 990-1009/1500');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [...Array(10).fill(1), ...Array(10).fill(2)]);
  assert.equal((await B.call('/api/takes')).body.takes.length, 0);
  await A.call(`/api/takes/${id}/share`, { shared: true });
  const bl = (await B.call('/api/takes')).body.takes;
  assert.equal(bl.length, 1); assert.equal(bl[0].by, 'Amina Otieno'); assert.equal(bl[0].mine, false);
  assert.equal((await B.call(`/api/takes/${id}/delete`, {})).status, 403, 'teammates cannot delete');
  const dl = await fetch(`${BASE}/api/takes/${id}/file?dl=1`, { headers: { cookie: B.cookie() } });
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="Opening take 1.mp4"/);
  assert.equal((await A.call(`/api/takes/${id}/delete`, {})).status, 200);
  assert.equal((await A.call('/api/takes')).body.takes.length, 0);
});

test('sign out ends the session', async () => {
  await A.call('/api/logout', {});
  assert.equal((await A.call('/api/me')).status, 401);
});

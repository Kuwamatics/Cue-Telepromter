// SomaPrompt platform layer.
// Gives the teleprompter page the same services it uses on claude.ai
// (db, user, room, dictation, sample), backed by this site's own server,
// plus the sign-in screen and the Account and team panel.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const domReady = new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error(j?.error || 'Something went wrong.'), { status: r.status });
    return j;
  }

  /* ---------- styles for the sign-in screen and account panel ---------- */
  const css = `
.cue-auth{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:#050505;color:#fff;padding:20px;overflow:auto}
.cue-auth .card{width:min(420px,100%);display:flex;flex-direction:column;gap:14px}
.cue-auth h1{font:800 40px/1.05 Archivo,system-ui,sans-serif;letter-spacing:-.02em;margin:0;display:flex;align-items:center;gap:12px}
.cue-auth h1 i{width:16px;height:16px;border-radius:50%;background:#ff2b2b;box-shadow:0 0 0 4px #ff2b2b4d,0 0 18px #ff2b2b}
.cue-auth p{margin:0;color:#bbb;font:16px/1.5 Archivo,system-ui,sans-serif}
.cue-auth .tabs{display:grid;grid-template-columns:1fr 1fr;border:1px solid #333;border-radius:10px;overflow:hidden}
.cue-auth .tabs button{min-height:44px;background:none;border:0;color:#bbb;font:600 15px Archivo,sans-serif;cursor:pointer}
.cue-auth .tabs button[aria-selected=true]{background:#1b1b1b;color:#fff}
.cue-auth label{display:flex;flex-direction:column;gap:6px;font:14px Archivo,sans-serif;color:#ccc}
.cue-auth input{font:16px Archivo,sans-serif;color:#fff;background:#111;border:1px solid #333;border-radius:8px;padding:11px 12px;min-height:44px}
.cue-auth input:focus-visible,.cue-auth button:focus-visible{outline:2px solid #ff2b2b;outline-offset:2px}
.cue-auth .go{min-height:48px;border-radius:10px;border:0;background:#ff2b2b;color:#fff;font:700 16px Archivo,sans-serif;cursor:pointer}
.cue-auth .go:disabled{opacity:.6}
.cue-auth .skip{background:none;border:0;color:#bbb;text-decoration:underline;font:14px Archivo,sans-serif;cursor:pointer;min-height:44px;align-self:flex-start;padding:0}
.cue-auth .err{color:#ff6b6b;font:14px Archivo,sans-serif;min-height:1.2em}
.cue-acct .who{font-size:15px;margin:0 0 4px}.cue-acct .who b{display:block}
.cue-acct .mem{font-size:14px;color:var(--mute);margin:4px 0 0}
.cue-acct .codebox{font:800 22px Archivo,sans-serif;letter-spacing:.12em}
.cue-player{border:0;padding:0;border-radius:12px;background:#000;color:#fff;width:min(960px,94vw);max-height:92vh;overflow:hidden}
.cue-player::backdrop{background:#000b}
.cue-player .hd{display:flex;align-items:center;gap:10px;padding:10px 12px;font:600 15px Archivo,sans-serif}
.cue-player .hd b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cue-player .btn{background:#151515;border-color:#333;color:#fff}
.cue-player video{display:block;width:100%;max-height:78vh;background:#000}
#libSec .take{flex-wrap:wrap;padding:8px 6px 4px 12px}
#libSec .take>div:first-child{flex:1 1 100%}
#libSec .take a.btn{text-decoration:none;color:var(--mute)}
`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  /* ---------- sign in ---------- */
  function showAuth(config) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'cue-auth'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'cueAuthT');
      el.innerHTML = `<form class="card" novalidate>
        <h1 id="cueAuthT"><i aria-hidden="true"></i>SomaPrompt</h1>
        <p>A teleprompter for presenters and teams. Sign in to sync your scripts, share them with your team and pair your phone as a remote.</p>
        <div class="tabs" role="tablist"><button type="button" role="tab" data-m="in" aria-selected="true">Sign in</button><button type="button" role="tab" data-m="up" aria-selected="false" ${config.signup ? '' : 'hidden'}>Create account</button></div>
        <label data-up hidden>Your name<input name="name" autocomplete="name" maxlength="60"></label>
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
        <div class="err" role="alert"></div>
        <button class="go" type="submit">Sign in</button>
        <button class="skip" type="button">Use SomaPrompt without an account on this device</button>
      </form>`;
      document.body.appendChild(el);
      const f = $('form', el); let mode = 'in';
      const setMode = (m) => {
        mode = m;
        el.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.m === m)));
        $('[data-up]', el).hidden = m !== 'up';
        $('.go', el).textContent = m === 'up' ? 'Create account' : 'Sign in';
        f.password.autocomplete = m === 'up' ? 'new-password' : 'current-password';
        $('.err', el).textContent = '';
      };
      el.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const go = $('.go', el); go.disabled = true; $('.err', el).textContent = '';
        try {
          const body = { email: f.email.value, password: f.password.value };
          if (mode === 'up') body.name = f.name.value;
          const me = await api(mode === 'up' ? '/api/signup' : '/api/login', body);
          lsSet('cue-local', null); el.remove(); resolve(me);
        } catch (err) { $('.err', el).textContent = err.message; go.disabled = false; }
      });
      $('.skip', el).addEventListener('click', () => { lsSet('cue-local', '1'); el.remove(); resolve(null); });
      setTimeout(() => f.email.focus(), 50);
    });
  }

  const configP = fetch('/api/config').then((r) => r.json()).catch(() => ({ ai: false, signup: true }));
  const OUTPUT = location.hash === '#output'; // second-screen window: driven by the main window, no account needed
  const meP = (async () => {
    if (OUTPUT) return null;
    try { const s = await api('/api/session'); if (s.me) return s.me; } catch {
      return null; // server unreachable: work offline on this device
    }
    if (lsGet('cue-local') === '1') return null;
    await domReady;
    return showAuth(await configP);
  })();

  /* ---------- live connection ---------- */
  let ws = null, myConn = null, rn = 0, qn = 0, backoff = 500, opened = false;
  const pending = new Map(), subs = new Map(), joined = new Map(), outbox = [];
  const connListeners = new Set();
  const setConnected = (v) => { if (opened !== v) { opened = v; connListeners.forEach((f) => f(v)); } };
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      backoff = 500;
      for (const [qid, s] of subs) ws.send(JSON.stringify({ t: 'sub', q: qid, path: s.path }));
      for (const name of joined.keys()) ws.send(JSON.stringify({ t: 'join', r: ++rn, room: name }));
      while (outbox.length) ws.send(outbox.shift());
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'hello') { myConn = m.conn; setConnected(true); }
      else if (m.t === 'snap') subs.get(m.q)?.deliver(m.docs);
      else if (m.t === 'suberr') { const s = subs.get(m.q); subs.delete(m.q); s?.err?.({ code: m.code, message: 'Not allowed' }); }
      else if (m.t === 'ok' || m.t === 'err') { const p = pending.get(m.r); if (p) { pending.delete(m.r); clearTimeout(p.timer); m.t === 'ok' ? p.res() : p.rej({ code: m.code, message: m.code }); } }
      else if (m.t === 'msg') joined.get(m.room)?.deliver(m);
      else if (m.t === 'peers') joined.get(m.room)?.peers(m.peers);
      else if (m.t === 'reload') location.reload();
    };
    ws.onclose = () => {
      setConnected(false);
      for (const [r, p] of pending) { clearTimeout(p.timer); p.rej({ code: 'unavailable', message: 'Connection lost' }); pending.delete(r); }
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000);
    };
  }
  const raw = (msg) => { const s = JSON.stringify(msg); ws && ws.readyState === 1 ? ws.send(s) : outbox.push(s); };
  function rpc(msg) {
    return new Promise((res, rej) => {
      const r = ++rn;
      const timer = setTimeout(() => { pending.delete(r); rej({ code: 'unavailable', message: 'No answer' }); }, 10000);
      pending.set(r, { res, rej, timer });
      raw({ ...msg, r });
    });
  }

  /* ---------- db ---------- */
  const snapOf = (docs) => {
    const ds = docs.map((d) => { const data = Object.freeze({ ...d.data }); return Object.freeze({ id: d.id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } }); });
    return { docs: ds, size: ds.length, empty: !ds.length, docChanges: () => ds.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  function collection(cpath) {
    return {
      path: cpath,
      doc(id) {
        id = id || 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        return {
          id, path: cpath + '/' + id,
          set: (data) => rpc({ t: 'set', path: cpath, id, data }),
          delete: () => rpc({ t: 'del', path: cpath, id }),
        };
      },
      onSnapshot(next, err) {
        const qid = ++qn;
        subs.set(qid, { path: cpath, deliver: (docs) => next(snapOf(docs)), err });
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'sub', q: qid, path: cpath }));
        return () => { if (subs.delete(qid)) raw({ t: 'unsub', q: qid }); };
      },
    };
  }
  const dbApi = Object.freeze({
    collection,
    doc(p) { const i = p.lastIndexOf('/'); return collection(p.slice(0, i)).doc(p.slice(i + 1)); },
  });

  /* ---------- room ---------- */
  function namedRoom(name) {
    const handlers = new Map(), peerFns = new Set();
    let last = [];
    const entry = {
      deliver(m) { for (const fn of handlers.get(m.topic) || []) { try { fn({ topic: m.topic, data: m.data, peer: m.from, by: null, isMe: true, sameTab: m.from === myConn, kind: 'viewer', guest: false }); } catch (e) { console.error(e); } } },
      peers(ids) {
        const mk = (id) => Object.freeze({ peer: id, by: null, isMe: true, sameTab: id === myConn, kind: 'viewer', guest: false, presence: {}, updatedAt: Date.now() });
        const peers = ids.map(mk);
        const ch = { peers, joined: peers.filter((p) => !last.includes(p.peer)), left: last.filter((id) => !ids.includes(id)).map(mk), updated: [] };
        last = ids;
        peerFns.forEach((f) => { try { f(ch); } catch (e) { console.error(e); } });
      },
    };
    joined.set(name, entry);
    return {
      name,
      emit: (topic, data) => rpc({ t: 'emit', room: name, topic, data }),
      on(topic, fn) { if (!handlers.has(topic)) handlers.set(topic, new Set()); handlers.get(topic).add(fn); return () => handlers.get(topic)?.delete(fn); },
      onPeers(fn) { peerFns.add(fn); return () => peerFns.delete(fn); },
      presence: async () => {},
      peers: () => last.map((id) => ({ peer: id, sameTab: id === myConn, isMe: true })),
      connected: () => opened,
      onConnection(fn) { connListeners.add(fn); queueMicrotask(() => fn(opened)); return () => connListeners.delete(fn); },
      async leave() { joined.delete(name); try { await rpc({ t: 'leave', room: name }); } catch {} },
    };
  }
  const roomApi = Object.freeze({
    async join(name) { const r = namedRoom(name); await rpc({ t: 'join', room: name }); return r; },
    connected: () => opened,
  });

  /* ---------- dictation (browser speech recognition) ---------- */
  function makeDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const part = new Set(), fin = new Set(), state = new Set();
    let rec = null, want = false;
    const emit = (set, v) => set.forEach((f) => { try { f(v); } catch (e) { console.error(e); } });
    return {
      start() {
        return new Promise((resolve, reject) => {
          want = true;
          rec = new SR();
          rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
          let started = false;
          rec.onstart = () => { started = true; emit(state, { state: 'listening' }); resolve(); };
          rec.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i];
              if (r.isFinal) emit(fin, { text: r[0].transcript }); else interim += r[0].transcript;
            }
            if (interim) emit(part, { text: interim });
          };
          rec.onerror = (e) => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { want = false; if (!started) reject({ code: 'not_granted' }); emit(state, { state: 'idle', reason: 'not_granted' }); }
          };
          rec.onend = () => { if (want) { try { rec.start(); return; } catch {} } emit(state, { state: 'idle', reason: 'stopped' }); };
          try { rec.start(); } catch (e) { reject({ code: 'dismissed', message: e.message }); }
        });
      },
      async stop() { want = false; try { rec?.stop(); } catch {} },
      onPartial: (f) => { part.add(f); return () => part.delete(f); },
      onFinal: (f) => { fin.add(f); return () => fin.delete(f); },
      onState: (f) => { state.add(f); return () => state.delete(f); },
    };
  }

  /* ---------- sample (AI assistant through the server) ---------- */
  async function sample(input, opts = {}) {
    const prompt = typeof input === 'string' ? input : input.map((m) => m.content).join('\n\n');
    let r;
    try {
      r = await fetch('/api/ai', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }), signal: opts.signal });
    } catch (e) { if (e.name === 'AbortError') throw e; throw { code: 'upstream_error', message: 'Network error' }; }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw { code: r.status === 429 ? 'rate_limited' : 'upstream_error', message: j.error || 'Error' }; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const delta = dec.decode(value, { stream: true });
      text += delta;
      opts.onText?.({ text, delta });
    }
    return { text, truncated: false };
  }

  /* ---------- the claude.use() entry point the page calls ---------- */
  let started = false;
  const ensureLive = () => { if (!started) { started = true; connect(); } };
  window.claude = Object.freeze({
    async use(name) {
      if (name === 'dictation') return makeDictation();
      const me = await meP;
      if (!me) return null;
      if (name === 'db') { ensureLive(); return dbApi; }
      if (name === 'room') { ensureLive(); return roomApi; }
      if (name === 'user') {
        return Object.freeze({
          id: async () => me.id,
          me: async () => ({ id: me.id, name: me.name }),
          isOwner: async () => true,
          canEdit: async () => true,
          can: async () => true,
          profiles: async (ids) => { try { return await api('/api/profiles?ids=' + encodeURIComponent(ids.join(','))); } catch { return {}; } },
        });
      }
      if (name === 'sample') return (await configP).ai ? sample : null;
      return null;
    },
  });

  /* ---------- takes: upload while recording ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function uploader(id) {
    const queue = []; let sent = 0, busy = false;
    const u = {
      id, state: 'uploading', sent: 0, error: '', onProgress: null,
      push(b) { queue.push(b); pump(); },
      async finish(dur) {
        while ((busy || queue.length) && u.state === 'uploading') await sleep(200);
        if (u.state !== 'uploading') throw new Error(u.error);
        await api(`/api/takes/${id}/finish`, { dur });
        u.state = 'done'; u.onProgress?.();
      },
    };
    async function pump() {
      if (busy || u.state !== 'uploading') return;
      busy = true;
      while (queue.length && u.state === 'uploading') {
        let tries = 0;
        for (;;) {
          try {
            const r = await fetch(`/api/takes/${id}/chunk?offset=${sent}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: queue[0] });
            const j = await r.json().catch(() => ({}));
            if (r.ok) { sent = j.size; queue.shift(); break; }
            if ([403, 404, 409, 413].includes(r.status)) { u.state = 'failed'; u.error = j.error || 'Upload refused'; break; }
            throw new Error('HTTP ' + r.status);
          } catch (e) {
            if (++tries > 10) { u.state = 'failed'; u.error = 'Connection lost'; break; }
            await sleep(Math.min(30000, 500 * 2 ** tries));
          }
        }
        u.sent = sent; u.onProgress?.();
      }
      busy = false;
    }
    return u;
  }
  window.cueTakes = Object.freeze({
    ready: meP.then((me) => !!me),
    async start(meta) { if (!(await meP)) throw new Error('Not signed in'); const { id } = await api('/api/takes', meta); return uploader(id); },
  });

  /* ---------- takes library panel ---------- */
  const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let player = null;
  function play(t) {
    if (!player) {
      player = document.createElement('dialog');
      player.className = 'cue-player';
      player.innerHTML = '<div class="hd"><b></b><button type="button" class="btn">Close</button></div><video controls playsinline preload="metadata"></video>';
      document.body.appendChild(player);
      $('button', player).onclick = () => player.close();
      player.addEventListener('close', () => { const v = $('video', player); v.pause(); v.removeAttribute('src'); v.load(); });
    }
    $('b', player).textContent = t.name;
    $('video', player).src = `/api/takes/${t.id}/file`;
    player.showModal();
    $('video', player).play().catch(() => {});
  }
  function takesPanel() {
    const sec = document.createElement('details');
    sec.className = 'sec'; sec.id = 'libSec';
    sec.innerHTML = '<summary>Takes library</summary><div id="cueTL"><p class="hint">Loading…</p></div>';
    ($('#recSec') || $('.note')).after(sec);
    const box = $('#cueTL', sec);
    let data = null, confirmId = null;
    const render = () => {
      if (!data) return;
      const pct = data.quota ? Math.min(100, (data.used / data.quota) * 100) : 0;
      box.innerHTML = `<p class="hint" style="margin-top:0">Using ${fmtSize(data.used)} of ${fmtSize(data.quota)}${pct > 90 ? '. Your library is almost full.' : '.'}</p>` +
        (data.takes.length ? '<div class="takes">' + data.takes.map((t) => `<div class="take"><div><b>${esc(t.name)}</b><span>${fmtDate(t.created)} · ${fmtDur(t.dur)} · ${fmtSize(t.size)} · ${t.mine ? 'you' : esc(t.by || 'teammate')}${t.shared ? ' · shared' : ''}${t.complete ? '' : ' · interrupted'}</span></div>
          <div class="row" style="flex:none;gap:2px">
            <button class="btn ghost" data-play="${t.id}">Play</button>
            <a class="btn ghost" href="/api/takes/${t.id}/file?dl=1">Save</a>
            ${t.mine ? `<button class="btn ghost" data-share="${t.id}">${t.shared ? 'Unshare' : 'Share'}</button><button class="btn ghost" data-delt="${t.id}">${confirmId === t.id ? 'Confirm delete' : 'Delete'}</button>` : ''}
          </div></div>`).join('') + '</div>'
          : '<p class="hint">Takes you record while signed in upload here, so you can play and download them on any device. Share a take to let your team see it.</p>');
    };
    const load = async () => { try { data = await api('/api/takes'); render(); } catch (e) { box.innerHTML = `<p class="msg">${esc(e.message)}</p>`; } };
    sec.addEventListener('toggle', () => { if (sec.open) load(); });
    window.addEventListener('cue:takes-changed', () => (sec.open ? load() : (sec.open = true)));
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const find = (id) => data.takes.find((t) => t.id === id);
      try {
        if (b.dataset.play) play(find(b.dataset.play));
        else if (b.dataset.share) { const t = find(b.dataset.share); await api(`/api/takes/${t.id}/share`, { shared: !t.shared }); load(); }
        else if (b.dataset.delt) {
          if (confirmId !== b.dataset.delt) { confirmId = b.dataset.delt; render(); setTimeout(() => { if (confirmId === b.dataset.delt) { confirmId = null; render(); } }, 4000); return; }
          confirmId = null; await api(`/api/takes/${b.dataset.delt}/delete`, {}); load();
        }
      } catch (err) { box.insertAdjacentHTML('afterbegin', `<p class="msg">${esc(err.message)}</p>`); }
    });
  }

  /* ---------- Account and team panel ---------- */
  function renderAccount(sec, me) {
    if (!me) {
      sec.innerHTML = `<summary>Account and team</summary>
        <p class="hint" style="margin-top:0">You're using SomaPrompt without an account. Scripts stay in this browser on this device.</p>
        <div class="row" style="margin-top:8px"><button class="btn" id="cueSignIn">Sign in or create an account</button></div>`;
      $('#cueSignIn', sec).onclick = () => { lsSet('cue-local', null); location.reload(); };
      return;
    }
    const others = me.team.members.filter((m) => m.id !== me.id);
    sec.innerHTML = `<summary>Account and team</summary>
      <p class="who"><b>${esc(me.name)}</b><span class="hint">${esc(me.email)}</span></p>
      <div class="grp">Team</div>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="cueTeamName" value="${esc(me.team.name)}" aria-label="Team name" maxlength="60"><button class="btn ghost" id="cueRename">Rename</button></div>
      <p class="mem">${others.length ? 'With ' + others.map((m) => esc(m.name)).join(', ') : 'Just you so far.'}</p>
      <div class="grp">Invite code</div>
      <div class="row"><span class="codebox" id="cueCode">${esc(me.team.code)}</span><button class="btn ghost" id="cueCopyCode">Copy</button><button class="btn ghost" id="cueNewCode">New code</button></div>
      <p class="hint">Teammates enter this code under Join a team. Making a new code stops the old one working.</p>
      <div class="grp">Join a team</div>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="cueJoin" placeholder="Invite code" aria-label="Invite code" maxlength="12" autocapitalize="characters"><button class="btn" id="cueJoinGo">Join</button></div>
      <p class="msg" id="cueAcctMsg" hidden></p>
      <div class="row" style="margin-top:10px">${others.length ? '<button class="btn ghost" id="cueLeave">Leave this team</button>' : ''}<button class="btn ghost" id="cueOut">Sign out</button></div>`;
    const msg = (t) => { const m = $('#cueAcctMsg', sec); m.textContent = t; m.hidden = !t; };
    const run = (p) => p.then((nme) => { if (nme) renderAccount(sec, Object.assign(me, nme)); }).catch((e) => msg(e.message));
    $('#cueRename', sec).onclick = () => run(api('/api/team/rename', { name: $('#cueTeamName', sec).value }));
    $('#cueNewCode', sec).onclick = () => run(api('/api/team/new-code', {}));
    $('#cueCopyCode', sec).onclick = (e) => { navigator.clipboard?.writeText(me.team.code).then(() => { e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1500); }, () => {}); };
    $('#cueJoinGo', sec).onclick = () => { const c = $('#cueJoin', sec).value.trim(); if (c) api('/api/team/join', { code: c }).then(() => location.reload(), (e) => msg(e.message)); };
    const lv = $('#cueLeave', sec); if (lv) lv.onclick = () => api('/api/team/leave', {}).then(() => location.reload(), (e) => msg(e.message));
    $('#cueOut', sec).onclick = () => api('/api/logout', {}).finally(() => { lsSet('cue-local', null); location.reload(); });
  }
  Promise.all([meP, domReady]).then(([me]) => {
    const side = $('.side'); if (!side || OUTPUT) return;
    const sec = document.createElement('details');
    sec.className = 'sec cue-acct'; sec.id = 'acctSec'; if (!me) sec.open = true;
    side.insertBefore(sec, $('.note', side));
    renderAccount(sec, me);
    if (me) takesPanel();
  });

  /* ---------- installable app ---------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

/* Online play: quick-match queue, private rooms, and server-run matches.
 * Each match runs the game's own rules (see gamevm.js) at 60 steps a second and sends snapshots at 20 a second. */
const crypto = require('crypto');
const { accept } = require('./ws');
const { loadScript, makeContext } = require('./gamevm');

const DEFAULTS = {
  QUEUE_WAIT_MS: +process.env.QUEUE_WAIT_MS || 10000, // how long Quick Game waits for more players before bots fill the rest
  MATCH_TIME: +process.env.MATCH_TIME || 300,
  MATCH_TARGET: +process.env.MATCH_TARGET || 30,
  COUNTDOWN: +process.env.COUNTDOWN || 4,
  MAX_MATCHES: +process.env.MAX_MATCHES || 40,
  MAX_PLAYERS: 20, // 10 per team
  ORIGIN: process.env.ALLOW_ORIGIN || '*'
};
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = s => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Player';

function create(deps, overrides) {
  const cfg = Object.assign({}, DEFAULTS, overrides || {});
  const script = loadScript();
  const clients = new Set(), byPid = new Map(), rooms = new Map(), matches = new Set();
  let queue = [], qTimer = null, qTick = null, qDeadline = 0;

  /* ---------- client helpers ---------- */
  class Client {
    constructor(ws) { this.ws = ws; this.pid = null; this.p = null; this.name = 'Player'; this.eq = 2; this.state = 'new'; this.room = null; this.match = null; this.idx = -1; this.active = false; }
    send(o, droppable) { return this.ws.send(typeof o === 'string' ? o : JSON.stringify(o), droppable); }
    err(m) { this.send({ t: 'err', m }); }
  }
  function profile(c, m) {
    if (typeof m.name === 'string') c.name = cleanName(m.name);
    const e = m.eq | 0; if (e >= 1 && e <= 9) c.eq = e;
  }

  function onConn(ws) {
    const c = new Client(ws);
    clients.add(c);
    const helloTimer = setTimeout(() => { if (c.state === 'new') ws.close(1008); }, 8000);
    ws.on('message', raw => { try { onMessage(c, raw); } catch (e) { console.error('message error', e); } });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      clients.delete(c);
      if (c.pid && byPid.get(c.pid) === c) byPid.delete(c.pid);
      leaveAll(c);
    });
  }

  function onMessage(c, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (c.state === 'new') { if (m.t === 'hello') hello(c, m); return; }
    switch (m.t) {
      case 'i': if (c.match) { if (m.ix || m.iy || m.att) c.active = true; c.match.input(c, raw); } break;
      case 'eq': if (c.match) c.match.input(c, raw); break;
      case 'p': c.send({ t: 'p', c: m.c }); break;
      case 'queue': if (c.state === 'idle' || c.state === 'queue' || c.state === 'room') joinQueue(c, m); break;
      case 'cancel': if (c.state === 'queue') { leaveAll(c); } break;
      case 'create': if (c.state !== 'match') createRoom(c, m); break;
      case 'join': if (c.state !== 'match') joinRoom(c, m); break;
      case 'start': startRoom(c); break;
      case 'leave': leaveAll(c); break;
    }
  }

  function hello(c, m) {
    const a = deps.authPlayer(String(m.id || ''), String(m.key || ''));
    if (!a) { c.err('Sign-in failed'); c.ws.close(1008); return; }
    const old = byPid.get(a.id);
    if (old && old !== c) { old.err('Signed in on another device'); old.ws.close(4000); }
    c.pid = a.id; c.p = a.p; byPid.set(a.id, c); c.state = 'idle';
    profile(c, m);
    c.send({ t: 'hello', ok: 1 });
  }

  function leaveAll(c) {
    if (c.state === 'queue') {
      queue = queue.filter(x => x !== c);
      if (!queue.length) stopQ(); else bcastQ();
    }
    if (c.room) leaveRoom(c);
    if (c.match) c.match.drop(c);
    if (c.state !== 'new') c.state = 'idle';
  }

  /* ---------- Quick Game queue ---------- */
  function stopQ() { clearTimeout(qTimer); clearInterval(qTick); qTimer = qTick = null; }
  function bcastQ() {
    const s = Math.max(0, Math.ceil((qDeadline - Date.now()) / 1000)), names = queue.map(c => c.name);
    queue.forEach(c => c.send({ t: 'q', n: queue.length, s, names }));
  }
  function joinQueue(c, m) {
    profile(c, m);
    leaveAll(c);
    c.state = 'queue'; queue.push(c);
    if (queue.length >= cfg.MAX_PLAYERS) { flushQueue(); return; }
    if (!qTimer) {
      qDeadline = Date.now() + cfg.QUEUE_WAIT_MS;
      qTimer = setTimeout(flushQueue, cfg.QUEUE_WAIT_MS);
      qTick = setInterval(bcastQ, 1000);
    }
    bcastQ();
  }
  function flushQueue() {
    stopQ();
    if (!queue.length) return;
    if (matches.size >= cfg.MAX_MATCHES) { qDeadline = Date.now() + 2000; qTimer = setTimeout(flushQueue, 2000); qTick = setInterval(bcastQ, 1000); bcastQ(); return; }
    const list = queue.splice(0, cfg.MAX_PLAYERS);
    startMatch(list);
    if (queue.length) { qDeadline = Date.now() + cfg.QUEUE_WAIT_MS; qTimer = setTimeout(flushQueue, cfg.QUEUE_WAIT_MS); qTick = setInterval(bcastQ, 1000); bcastQ(); }
  }

  /* ---------- private rooms ---------- */
  function newCode() { for (;;) { let s = ''; for (let i = 0; i < 4; i++) s += ALPHA[crypto.randomInt(ALPHA.length)]; if (!rooms.has(s)) return s; } }
  function roomUpdate(r) { r.members.forEach(c => c.send({ t: 'room', code: r.code, members: r.members.map(x => x.name), host: c === r.host })); }
  function createRoom(c, m) {
    profile(c, m); leaveAll(c);
    if (rooms.size > 500) { c.err('Too many rooms right now, try again soon'); return; }
    const r = { code: newCode(), host: c, members: [c] };
    rooms.set(r.code, r); c.room = r; c.state = 'room'; roomUpdate(r);
  }
  function joinRoom(c, m) {
    profile(c, m);
    const r = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!r) { c.err('Room not found. Check the code.'); return; }
    if (r.members.includes(c)) { roomUpdate(r); return; }
    if (r.members.length >= cfg.MAX_PLAYERS) { c.err('That room is full.'); return; }
    leaveAll(c);
    r.members.push(c); c.room = r; c.state = 'room'; roomUpdate(r);
  }
  function leaveRoom(c) {
    const r = c.room; c.room = null;
    if (!r) return;
    r.members = r.members.filter(x => x !== c);
    if (!r.members.length) { rooms.delete(r.code); return; }
    if (r.host === c) r.host = r.members[0];
    roomUpdate(r);
  }
  function startRoom(c) {
    const r = c.room;
    if (!r || r.host !== c) return;
    if (matches.size >= cfg.MAX_MATCHES) { c.err('Servers are full, try again soon.'); return; }
    rooms.delete(r.code);
    const list = r.members.slice();
    list.forEach(x => { x.room = null; });
    startMatch(list);
  }

  /* ---------- matches ---------- */
  class Match {
    constructor(list) {
      this.humans = list.slice(); this.over = false; this.n = 0;
      this.ctx = makeContext(script);
      const players = list.map((c, i) => ({ n: c.name, t: i % 2, eq: c.eq, id: c.pid }));
      this.teamOf = players.map(p => p.t);
      const info = JSON.parse(this.ctx.netNew(JSON.stringify({ players, time: cfg.MATCH_TIME, target: cfg.MATCH_TARGET, cd: cfg.COUNTDOWN })));
      /* humans fill each team's slots in order: team 0 -> indexes 0..9, team 1 -> 10..19 */
      const used = [0, 0];
      list.forEach((c, i) => { const t = this.teamOf[i]; c.idx = t * 10 + used[t]++; c.match = this; c.state = 'match'; c.active = false; c.team = t; });
      const skins = info.map(() => 'wand'); list.forEach(c => { skins[c.idx] = (c.p && c.p.eq) || 'wand'; });
      this.info = info.map((f, i) => Object.assign(f, { s: skins[i] }));
      list.forEach(c => c.send({ t: 'm', you: c.idx, players: this.info, time: cfg.MATCH_TIME, target: cfg.MATCH_TARGET, cd: cfg.COUNTDOWN }));
    }
    input(c, raw) { if (!this.over) this.ctx.netIn(c.idx, raw); }
    drop(c) {
      this.humans = this.humans.filter(x => x !== c);
      c.match = null; c.state = 'idle';
      if (!this.over) { try { this.ctx.netDrop(c.idx); } catch (e) {} }
      if (!this.humans.length) this.end();
    }
    tick() {
      if (this.over) return;
      try {
        this.ctx.netStep(1 / 60);
        if (++this.n % 3 === 0) {
          const s = this.ctx.netSnap();
          for (const c of this.humans) c.send(s, true);
        }
        if (this.ctx.netDone()) this.finish();
      } catch (e) {
        console.error('match crashed', e);
        this.humans.slice().forEach(c => { c.err('The match ended because of a server error.'); c.match = null; c.state = 'idle'; });
        this.humans = []; this.end();
      }
    }
    finish() {
      const r = JSON.parse(this.ctx.netResult());
      this.over = true;
      for (const c of this.humans) {
        const t = c.team, win = r.w === t, draw = r.w === -1, kills = (r.p[c.idx] || [0])[0];
        let rew = 0;
        if (c.active) rew = (win ? 120 : draw ? 60 : 40) + kills * 4 + (r.mvp === c.idx ? 30 : 0);
        const bal = rew ? deps.credit(c.pid, rew) : (c.p ? c.p.em : 0);
        c.send({ t: 'over', w: r.w, sc: r.sc, p: r.p, mvp: r.mvp, rew, bal, you: c.idx, mt: t });
        c.match = null; c.state = 'idle';
      }
      this.humans = []; this.end();
    }
    end() { this.over = true; matches.delete(this); this.ctx = null; }
  }
  function startMatch(list) {
    try { matches.add(new Match(list)); }
    catch (e) { console.error('could not start match', e); list.forEach(c => { c.err('Could not start the match.'); c.state = 'idle'; }); }
  }
  /* Matches that were added before construction finished are in the set via add(new Match()). */

  /* Fixed-step loop: 60 steps a second, catching up if the server was briefly late. */
  let last = Date.now(), acc = 0;
  const STEP = 1000 / 60;
  const loop = setInterval(() => {
    const now = Date.now(); acc += Math.min(250, now - last); last = now;
    let n = 0;
    while (acc >= STEP && n < 6) { acc -= STEP; n++; for (const m of matches) m.tick(); }
    if (n === 6) acc = 0;
  }, 8);
  /* Drop dead connections. */
  const hb = setInterval(() => { for (const c of clients) { if (!c.ws.alive) { c.ws.terminate(); continue; } c.ws.ping(); } }, 20000);

  return {
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
        accept(req, socket, head, onConn, { origin: cfg.ORIGIN, maxPayload: 16384 });
      });
    },
    stats() { return { players: clients.size, queued: queue.length, rooms: rooms.size, matches: matches.size }; },
    close() { clearInterval(loop); clearInterval(hb); stopQ(); clients.forEach(c => c.ws.close(1001)); }
  };
}

module.exports = { create };

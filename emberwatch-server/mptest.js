/* Multiplayer integration test: real WebSocket clients against a real server instance.
 * Run: node mptest.js   (needs Node 22+ for the built-in WebSocket client) */
process.env.MOCK_PLAY = '1';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), 'ew-mp-' + Date.now() + '.json');
process.env.QUEUE_WAIT_MS = '1500'; process.env.MATCH_TIME = '14'; process.env.COUNTDOWN = '1'; process.env.MATCH_TARGET = '30';
const crypto = require('crypto'), assert = require('assert');
const server = require('./server');
const hub = server.hub;
const rnd = n => crypto.randomBytes(n).toString('hex');

function client(name, base) {
  const id = rnd(16), key = rnd(24);
  const c = { id, key, name, snaps: 0, msgs: [], over: null, matchInfo: null, last: null, ws: null };
  c.ready = new Promise((ok, no) => {
    const ws = c.ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', id, key, name, eq: 3 }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 'hello') ok();
      else if (m.t === 's') { c.snaps++; c.last = m; }
      else { c.msgs.push(m); if (m.t === 'm') c.matchInfo = m; if (m.t === 'over') c.over = m; if (m.t === 'err') c.err = m.m; }
    };
    ws.onerror = e => no(e);
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms, what) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what); await wait(25); } }

server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    /* ---- quick match with 3 humans ---- */
    const A = client('Ana', base), B = client('Bo', base), C = client('Cy', base);
    await Promise.all([A.ready, B.ready, C.ready]);
    [A, B, C].forEach(c => c.send({ t: 'queue', eq: 4, name: c.name }));
    await until(() => A.matchInfo && B.matchInfo && C.matchInfo, 6000, 'match start');
    assert.equal(A.matchInfo.players.length, 20);
    assert.equal(A.matchInfo.players.filter(p => p.h).length, 3, '3 humans');
    assert.notEqual(A.matchInfo.you, B.matchInfo.you);
    console.log('match started; slots', A.matchInfo.you, B.matchInfo.you, C.matchInfo.you);
    /* A walks right and swings, B and C stay idle for a bit */
    const driver = setInterval(() => {
      A.send({ t: 'i', ix: 1, iy: Math.sin(Date.now() / 700), a: 0, att: true });
      B.send({ t: 'i', ix: Math.cos(Date.now() / 900), iy: 0, a: 3.14, att: Math.random() < .5 });
    }, 33);
    await wait(2500);
    assert(A.snaps > 30, 'snapshots flowing: ' + A.snaps);
    const rate = A.snaps / 2.5;
    console.log('snapshots per second ~' + rate.toFixed(1));
    const me0 = A.last.f[A.matchInfo.you];
    await wait(1500);
    const me1 = A.last.f[A.matchInfo.you];
    console.log('Ana moved', me0.slice(0, 2), '->', me1.slice(0, 2));
    assert(Math.hypot(me1[0] - me0[0], me1[1] - me0[1]) > 3 || me1[6] & 1, 'player moves');
    /* cheating attempt: absurd input values must be clamped, not teleport */
    C.send({ t: 'i', ix: 9999, iy: -9999, a: 1e30, att: true });
    await wait(600);
    const cRow = C.last.f[C.matchInfo.you];
    assert(cRow[0] >= 0 && cRow[0] <= 320 && cRow[1] >= 0 && cRow[1] <= 180, 'cheat input stays in bounds');
    /* weapon swap is honored, bad ones ignored */
    B.send({ t: 'eq', v: 1 }); B.send({ t: 'i', eq: 7 }); await wait(200);
    assert.equal(B.last.f[B.matchInfo.you][5], 7, 'weapon swap');
    B.send({ t: 'i', eq: 99 }); await wait(200);
    assert.equal(B.last.f[B.matchInfo.you][5], 7, 'invalid weapon ignored');
    /* wait for the timer to end the match */
    await until(() => A.over && B.over && C.over, 25000, 'match over');
    clearInterval(driver);
    console.log('over:', JSON.stringify({ w: A.over.w, sc: A.over.sc, rewA: A.over.rew, rewB: B.over.rew, rewC: C.over.rew }));
    assert(A.over.rew >= 40 && B.over.rew >= 40, 'active players rewarded');
    assert.equal(C.over.rew >= 0, true);
    /* wallet matches reported balance */
    const w = await (await fetch(base + '/api/wallet', { headers: { 'x-player': A.id, 'x-key': A.key } })).json();
    assert.equal(w.em, A.over.bal, 'server wallet = reported balance');
    console.log('Ana balance', w.em);

    /* ---- private room ---- */
    const H = client('Host', base), G = client('Guest', base);
    await Promise.all([H.ready, G.ready]);
    H.send({ t: 'create', eq: 2, name: 'Host' });
    await until(() => H.msgs.some(m => m.t === 'room'), 3000, 'room created');
    const code = H.msgs.find(m => m.t === 'room').code;
    assert(/^[A-Z2-9]{4}$/.test(code));
    G.send({ t: 'join', code: 'ZZZZ' }); await until(() => G.err, 2000, 'bad code error');
    G.send({ t: 'join', code: code.toLowerCase() });
    await until(() => G.msgs.some(m => m.t === 'room'), 3000, 'guest joined');
    await wait(100);
    assert.equal(H.msgs.filter(m => m.t === 'room').pop().members.length, 2);
    G.send({ t: 'start' }); await wait(300);
    assert(!G.matchInfo, 'only the host can start');
    H.send({ t: 'start' });
    await until(() => H.matchInfo && G.matchInfo, 4000, 'room match start');
    assert.notEqual(H.matchInfo.players[H.matchInfo.you].t, G.matchInfo.players[G.matchInfo.you].t, 'friends land on opposite teams');
    console.log('room', code, 'match started with', H.matchInfo.players.filter(p => p.h).length, 'humans');
    /* guest disconnects mid-match: a bot takes over, match continues */
    G.ws.close(); await wait(500);
    const before = H.snaps; await wait(500);
    assert(H.snaps > before, 'match continues after a player leaves');
    H.ws.close(); await wait(500);
    console.log('server stats', JSON.stringify(hub.stats()));
    assert.equal(hub.stats().matches, 0, 'empty matches are cleaned up');
    console.log('all multiplayer tests passed');
    [A, B, C].forEach(c => c.ws.close());
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  hub.close(); server.close(); setTimeout(() => process.exit(), 300);
});

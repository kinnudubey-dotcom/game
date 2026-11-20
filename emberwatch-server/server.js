/* Emberwatch wallet server (zero dependencies, Node 18+).
 * Holds the authoritative Embers balance, verifies Google Play purchases,
 * and sells skins.
 * Storage is a JSON file so it runs anywhere; use a real database before real traffic. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PACKAGE_NAME = process.env.PLAY_PACKAGE || 'com.example.emberwatch'; // your Play package id
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MOCK_PLAY = process.env.MOCK_PLAY === '1'; // tests only; never set in production

/* Keep in sync with the Play Console in-app product ids and the game. */
const PACKS = { embers_500: 500, embers_1300: 1300, embers_3500: 3500, embers_8000: 8000 };
/* One-time (non-consumable) products. */
const ONCE = { remove_ads: { flag: 'noAds' }, starter_pack: { flag: 'starter', em: 1500, skin: 'ronin' } };
const SKINS = { wand: 0, ash: 300, druid: 600, frost: 500, reaper: 800, bone: 800, ronin: 1200, void: 1500, royal: 1500 };
const EARN_MAX = 400, EARN_COOLDOWN_MS = 40000;

/* ---------- storage ---------- */
let db = { players: {}, purchases: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}
fs.mkdirSync(path.dirname(DATA), { recursive: true });
let saving = false, again = false;
function save() {
  if (saving) { again = true; return; }
  saving = true;
  const tmp = DATA + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (!err) { try { fs.renameSync(tmp, DATA); } catch (e) {} }
    saving = false;
    if (again) { again = false; save(); }
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const view = p => ({ em: p.em, own: p.own, eq: p.eq, noAds: !!p.noAds, starter: !!p.starter });
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------- Google Play verification via REST (service account JWT) ---------- */
let gTok = { v: '', exp: 0 };
const b64u = b => Buffer.from(b).toString('base64url');
async function googleToken() {
  if (gTok.exp > Date.now() + 60000) return gTok.v;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('google auth failed');
  gTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
  return gTok.v;
}
async function verifyPlay(productId, token) {
  if (MOCK_PLAY) return token.startsWith('valid-');
  const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + encodeURIComponent(PACKAGE_NAME) + '/purchases/products/' + encodeURIComponent(productId) + '/tokens/' + encodeURIComponent(token);
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + await googleToken() } });
  if (r.status === 404 || r.status === 410 || r.status === 400) return false;
  if (!r.ok) throw new Error('google api ' + r.status);
  const j = await r.json();
  return j.purchaseState === 0; // 0 purchased, 1 canceled, 2 pending
}

/* ---------- http helpers ---------- */
function send(res, code, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type,x-player,x-key', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(body);
}
function readBody(req, limit = 262144) {
  return new Promise((ok, no) => {
    const c = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > limit) { no(new Error('too large')); req.destroy(); } else c.push(d); });
    req.on('end', () => ok(Buffer.concat(c).toString('utf8')));
    req.on('error', no);
  });
}
function authPlayer(id, key) {
  id = String(id || ''); key = String(key || '');
  if (!/^[a-f0-9]{32}$/.test(id) || key.length < 16 || key.length > 200) return null;
  let p = db.players[id];
  if (!p) { p = db.players[id] = { keyHash: sha(key), em: 0, own: ['wand'], eq: 'wand', lastEarn: 0, created: Date.now() }; save(); }
  else if (!same(p.keyHash, sha(key))) return null;
  return { id, p };
}
function auth(req) { return authPlayer(req.headers['x-player'], req.headers['x-key']); }
/* Used by the multiplayer hub to pay match rewards. Returns the new balance. */
function credit(pid, em) { const p = db.players[pid]; if (!p) return 0; p.em += em; save(); return p.em; }

/* ---------- routes ---------- */
async function api(req, res, url) {
  if (req.method === 'GET' && url === '/api/health') return send(res, 200, Object.assign({ ok: true }, hub ? hub.stats() : {}));
  const a = auth(req);
  if (!a) return send(res, 401, { error: 'bad credentials' });
  const { id, p } = a;
  if (req.method === 'GET' && url === '/api/wallet') return send(res, 200, view(p));
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  let b; try { b = JSON.parse((await readBody(req, 16384)) || '{}'); } catch (e) { return send(res, 400, { error: 'bad json' }); }

  if (url === '/api/earn') { /* free Embers for finished matches: capped and rate limited */
    const n = Math.floor(Number(b.amount)), now = Date.now();
    if (!(n > 0)) return send(res, 400, { error: 'bad amount' });
    if (now - p.lastEarn >= EARN_COOLDOWN_MS) { p.lastEarn = now; p.em += Math.min(n, EARN_MAX); save(); }
    return send(res, 200, view(p));
  }
  if (url === '/api/buy-skin') {
    const s = String(b.id);
    if (!(s in SKINS)) return send(res, 400, { error: 'unknown skin' });
    if (!p.own.includes(s)) {
      if (p.em < SKINS[s]) return send(res, 402, Object.assign({ error: 'not enough embers' }, view(p)));
      p.em -= SKINS[s]; p.own.push(s);
    }
    p.eq = s; save(); return send(res, 200, view(p));
  }
  if (url === '/api/equip') {
    const s = String(b.id);
    if (!p.own.includes(s)) return send(res, 400, { error: 'not owned' });
    p.eq = s; save(); return send(res, 200, view(p));
  }
  if (url === '/api/play/verify') { /* the game sends the purchase token; we ask Google, then credit exactly once */
    const productId = String(b.productId || ''), token = String(b.token || '');
    if (!(productId in PACKS || productId in ONCE) || token.length < 8 || token.length > 4096) return send(res, 400, { error: 'bad request' });
    const key = 'play:' + sha(token);
    if (db.purchases[key]) return send(res, 200, Object.assign(view(p), { duplicate: true }));
    try { if (!(await verifyPlay(productId, token))) return send(res, 402, { error: 'purchase not completed' }); }
    catch (e) { console.error('play verify failed:', e.message); return send(res, 502, { error: 'could not verify purchase, try again' }); }
    if (db.purchases[key]) return send(res, 200, Object.assign(view(p), { duplicate: true }));
    if (productId in ONCE) {
      const o = ONCE[productId];
      db.purchases[key] = { pid: id, productId, em: o.em || 0, at: Date.now() };
      if (!p[o.flag]) { p[o.flag] = true; if (o.em) p.em += o.em; if (o.skin && !p.own.includes(o.skin)) p.own.push(o.skin); }
      save();
      return send(res, 200, view(p));
    }
    db.purchases[key] = { pid: id, productId, em: PACKS[productId], at: Date.now() };
    p.em += PACKS[productId]; save();
    return send(res, 200, view(p));
  }
  if (url === '/api/delete-account') { /* erases the wallet record; purchase receipts stay for accounting but lose the link to the player */
    for (const k of Object.keys(db.purchases)) if (db.purchases[k].pid === id) db.purchases[k].pid = null;
    delete db.players[id]; save();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/play')) {
      /* Opens the game in any browser, already connected to this server. */
      let html = fs.readFileSync(path.join(__dirname, 'game.html'), 'utf8');
      html = html.replace('<script>', '<script>window.EMBER_API=location.origin;</script>\n<script>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(html);
    }
    if (req.method === 'GET' && (url === '/privacy' || url === '/privacy-policy')) {
      let html = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8');
      html = html.split('{{DEVELOPER}}').join(esc(process.env.DEVELOPER_NAME || '[set DEVELOPER_NAME]')).split('{{EMAIL}}').join(esc(process.env.CONTACT_EMAIL || '[set CONTACT_EMAIL]'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (url.startsWith('/api/')) return await api(req, res, url);
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); try { send(res, 500, { error: 'server error' }); } catch (_) {} }
});
/* Online multiplayer (WebSocket at /ws). Needs the game file next to this server (game.html) or GAME_HTML set. */
let hub = null;
if (process.env.NO_MULTIPLAYER !== '1') {
  try { hub = require('./multiplayer').create({ authPlayer, credit }); hub.attach(server); }
  catch (e) { console.error('Multiplayer is off:', e.message); }
}
if (require.main === module) server.listen(PORT, () => console.log('Emberwatch server on ' + PORT + (hub ? ' (multiplayer on)' : ' (multiplayer off)')));
server.hub = hub;
module.exports = server;

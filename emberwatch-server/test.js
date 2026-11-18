process.env.MOCK_PLAY = '1';
process.env.NO_MULTIPLAYER = '1';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), 'ew-test-' + Date.now() + '.json');
const crypto = require('crypto'), assert = require('assert');
const app = require('./server');
const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const pid = crypto.randomBytes(16).toString('hex'), key = crypto.randomBytes(16).toString('hex');
  const H = { 'content-type': 'application/json', 'x-player': pid, 'x-key': key };
  const call = async (p, b, h = H) => { const r = await fetch(base + p, { method: b ? 'POST' : 'GET', headers: h, body: b ? JSON.stringify(b) : undefined }); return [r.status, r.status === 204 ? null : await r.json().catch(() => null)]; };
  try {
    let [s, w] = await call('/api/wallet'); assert.equal(s, 200); assert.equal(w.em, 0);
    [s] = await call('/api/wallet', null, { ...H, 'x-key': 'wrongwrongwrongwrong' }); assert.equal(s, 401);
    [s, w] = await call('/api/play/verify', { productId: 'embers_500', token: 'invalid-token-123' }); assert.equal(s, 402);
    [s, w] = await call('/api/play/verify', { productId: 'embers_500', token: 'valid-token-123' }); assert.equal(s, 200); assert.equal(w.em, 500);
    [s, w] = await call('/api/play/verify', { productId: 'embers_500', token: 'valid-token-123' }); assert.equal(w.em, 500, 'replayed token must not double credit');
    [s] = await call('/api/play/verify', { productId: 'fake', token: 'valid-token-123' }); assert.equal(s, 400);
    [s, w] = await call('/api/play/verify', { productId: 'starter_pack', token: 'valid-starter-1' }); assert.equal(s, 200); assert.equal(w.em, 2000); assert(w.own.includes('ronin')); assert.equal(w.starter, true);
    [s, w] = await call('/api/play/verify', { productId: 'starter_pack', token: 'valid-starter-2' }); assert.equal(w.em, 2000, 'starter pack only once');
    [s, w] = await call('/api/play/verify', { productId: 'remove_ads', token: 'valid-noads-1' }); assert.equal(w.noAds, true); assert.equal(w.em, 2000);
    [s, w] = await call('/api/wallet'); assert.equal(w.noAds, true);
    [s, w] = await call('/api/buy-skin', { id: 'royal' }); assert.equal(s, 200); [s, w] = await call('/api/buy-skin', { id: 'void' }); assert.equal(s, 402);
    [s, w] = await call('/api/buy-skin', { id: 'ash' }); assert.equal(s, 200); assert.equal(w.eq, 'ash'); var EM0 = w.em;
    [s, w] = await call('/api/earn', { amount: 100000 }); assert.equal(w.em - EM0, 400, 'earn capped at 400');
    [s, w] = await call('/api/earn', { amount: 100 }); assert.equal(w.em - EM0, 400, 'earn rate limited');
    [s] = await call('/api/equip', { id: 'void' }); assert.equal(s, 400);
    [s, w] = await call('/api/delete-account', {}); assert.equal(s, 200);
    [s, w] = await call('/api/wallet'); assert.equal(s, 200); assert.equal(w.em, 0, 'wallet is fresh after delete'); assert.equal(w.noAds, false);
    const pr = await fetch(base + '/privacy'); const ph = await pr.text(); assert.equal(pr.status, 200); assert(ph.includes('Privacy Policy'));
    console.log('all server tests passed');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  srv.close();
});

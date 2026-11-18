/* Loads the game's own script into a headless sandbox so the server runs the exact same rules as the game. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function findGameFile() {
  const c = [process.env.GAME_HTML, path.join(__dirname, 'game.html'), path.join(__dirname, '..', 'emberwatch.html')].filter(Boolean);
  for (const f of c) if (fs.existsSync(f)) return f;
  throw new Error('Game file not found. Copy emberwatch.html next to server.js as game.html, or set GAME_HTML.');
}
function loadScript(file) {
  const html = fs.readFileSync(file || findGameFile(), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) throw new Error('No inline game script found');
  blocks.sort((a, b) => b.length - a.length);
  return new vm.Script(blocks[0], { filename: 'game.js' });
}

/* An object that accepts any property read, call or assignment. It stands in for the browser's DOM and canvas. */
function stub() {
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      return p;
    },
    apply() { return p; },
    construct() { return p; },
    set() { return true; },
    has() { return true; }
  });
  return p;
}

function makeContext(script) {
  const noop = () => 0;
  const sb = {
    document: stub(), navigator: {}, screen: {},
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    performance: { now: () => Date.now() },
    requestAnimationFrame: noop, setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false }),
    innerWidth: 1000, innerHeight: 600,
    getComputedStyle: () => stub(),
    crypto: require('crypto').webcrypto,
    fetch: () => Promise.reject(new Error('offline')),
    Image: function () { return stub(); },
    console: { log: noop, warn: noop, error: (...a) => console.error('[game]', ...a) }
  };
  sb.window = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  script.runInContext(ctx, { timeout: 5000 });
  return ctx;
}

module.exports = { loadScript, makeContext, findGameFile };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { create } = require(path.join(root, 'assets/storage.js'));
test('failed writes stay pending, latest values win, retry restores consistency', () => {
  let failed = true;
  const data = new Map();
  const store = create(() => ({
    setItem(k,v) { if (failed) throw Error('quota'); data.set(k,v); },
    removeItem(k) { if (failed) throw Error('blocked'); data.delete(k); }
  }), () => {});
  assert.throws(() => store.setItem('coins', 10));
  assert.throws(() => store.setItem('coins', 5));
  assert.throws(() => store.setItem('skins', '["gold"]'));
  assert.equal(store.pendingCount(), 2);
  assert.deepEqual(store.status(), { pending: 2, writes: 0, lastSavedAt: null });
  failed = false; assert.equal(store.retry(), true);
  assert.equal(data.get('coins'), '5'); assert.equal(data.get('skins'), '["gold"]');
  const receipt = store.status();
  assert.equal(receipt.writes, 2); assert.equal(receipt.pending, 0); assert.ok(Number.isFinite(receipt.lastSavedAt));
  assert.equal(store.retry(), true); assert.deepEqual(store.status(), receipt);
  failed = true; assert.throws(() => store.removeItem('coins'));
  failed = false; store.retry(); assert.equal(data.has('coins'), false);
});
// The service worker's current release cache is versioned (tank-battle-v<ver>); derive it
// from sw.js so this test stays correct as the app version advances instead of hardcoding
// a stale cache name (e.g. v101 from the v1.0.x era) that the SW now rightly deletes as old.
const SW_SRC = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const SW_CACHE = (SW_SRC.match(/const\s+CACHE\s*=\s*'([^']+)'/) || [])[1] || 'tank-battle-v101';
function worker(fetch) {
  const handlers = {}, removed = [], cached = new Map();
  const context = { URL, Response, AbortController, setTimeout, clearTimeout,
    fetch, self: { location: { origin: 'https://game.test' }, clients: { claim() {} },
      skipWaiting() {}, addEventListener(k,v) { handlers[k] = v; } },
    caches: { async keys() { return ['other-app', 'tank-battle-old', SW_CACHE]; },
      async delete(k) { removed.push(k); }, async open() { return {
        async addAll() {}, async match(k) { return cached.get(typeof k === 'string' ? k : k.url); }
      }; } }
  };
  vm.runInNewContext(SW_SRC, context);
  return { handlers, removed, cached, context };
}
test('activation preserves caches belonging to other apps', async () => {
  const w = worker(); let done;
  w.handlers.activate({ waitUntil(p) { done = p; } }); await done;
  assert.deepEqual(w.removed, ['tank-battle-old']);
});
test('offline navigation gets installed page, missing assets never get HTML', async () => {
  const w = worker(async () => { throw Error('offline'); });
  w.cached.set('./index.html', new Response('game'));
  let response;
  w.handlers.fetch({ request: { method:'GET', mode:'navigate', url:'https://game.test/' }, respondWith(p) { response=p; } });
  assert.equal(await (await response).text(), 'game');
  w.handlers.fetch({ request: { method:'GET', mode:'cors', url:'https://game.test/missing.png' }, respondWith(p) { response=p; } });
  await assert.rejects(response, /offline/);
});
test('HTTP failures fall back only for navigation', async () => {
  const w = worker(async () => new Response('missing', { status:404 }));
  w.cached.set('./index.html', new Response('installed'));
  let response;
  w.handlers.fetch({ request:{ method:'GET', mode:'navigate', url:'https://game.test/' }, respondWith(p){response=p;} });
  assert.equal(await (await response).text(), 'installed');
  w.handlers.fetch({ request:{ method:'GET', mode:'cors', url:'https://game.test/missing.png' }, respondWith(p){response=p;} });
  assert.equal((await response).status,404);
});
test('hung navigation is aborted and falls back', async () => {
  const w = worker((_, {signal}) => new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(Error('timeout')))));
  w.context.setTimeout = fn => setTimeout(fn, 5);
  w.cached.set('./index.html',new Response('cached'));
  let response;
  w.handlers.fetch({request:{method:'GET',mode:'navigate',url:'https://game.test/'},respondWith(p){response=p;}});
  assert.equal(await (await response).text(),'cached');
});

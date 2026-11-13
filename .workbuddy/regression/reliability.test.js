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
  failed = false; assert.equal(store.retry(), true);
  assert.equal(data.get('coins'), '5'); assert.equal(data.get('skins'), '["gold"]');
  failed = true; assert.throws(() => store.removeItem('coins'));
  failed = false; store.retry(); assert.equal(data.has('coins'), false);
});
function worker(fetch) {
  const handlers = {}, removed = [], cached = new Map();
  const context = { URL, Response, AbortController, setTimeout, clearTimeout,
    fetch, self: { location: { origin: 'https://game.test' }, clients: { claim() {} },
      skipWaiting() {}, addEventListener(k,v) { handlers[k] = v; } },
    caches: { async keys() { return ['other-app', 'tank-battle-old', 'tank-battle-v100']; },
      async delete(k) { removed.push(k); }, async open() { return {
        async addAll() {}, async match(k) { return cached.get(typeof k === 'string' ? k : k.url); }
      }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
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

/* Navigation uses a bounded network attempt; static assets use the release cache. */
const CACHE = 'tank-battle-v1225';
const PREFIX = 'tank-battle-';
const ASSETS = ['./', './index.html', './assets/game.css', './assets/storage.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
async function networkFirst(request, fallbackKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(request, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) throw new Error('Network failed');
    const cache = await caches.open(CACHE);
    cache.put(fallbackKey || request, response.clone()).catch(() => {});
    return response;
  } catch (_) {
    return (await (await caches.open(CACHE)).match(fallbackKey || request)) || Response.error();
  } finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') { event.respondWith(networkFirst(request, './index.html')); return; }
  if (/\.(css|js|html)$/i.test(url.pathname)) { event.respondWith(networkFirst(request)); return; }
  event.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(request);
    return hit || fetch(request); // Never substitute HTML for a missing image/script.
  }));
});

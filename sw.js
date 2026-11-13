/* Navigation uses a bounded network attempt; static assets use the release cache. */
const CACHE = 'tank-battle-v1039';
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
async function navigation(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (!response.ok) throw new Error('Navigation failed');
    // Keep the installed HTML and assets from the same release. A new SW updates both.
    return response;
  } catch (_) {
    return (await (await caches.open(CACHE)).match('./index.html')) || Response.error();
  } finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') { event.respondWith(navigation(request)); return; }
  event.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(request);
    return hit || fetch(request); // Never substitute HTML for a missing image/script.
  }));
});

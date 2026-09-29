// Offline support: serve the app shell from cache, refresh it in the background.
const CACHE = 'tally-v17';
const SHELL = ['./', 'index.html', 'model.js', 'curves.js', 'engine.js', 'templates.js', 'transactions.js', 'analysis.js', 'mc-worker.js', 'storage.js', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

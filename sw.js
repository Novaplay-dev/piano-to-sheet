// Offline app shell. Bump VERSION when files change.
const VERSION = 'v16';
const FILES = ['./', 'index.html', 'notation.js', 'songs.js', 'player.js', 'pdf.js', 'vendor/abcjs-basic-min.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
// network first (so updates show up), cache as fallback when offline
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // piano sound samples for "Play sheet": download once, then work offline
  if (e.request.url.includes('midi-js-soundfonts')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })));
    return;
  }
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

// Service Worker — L'Académie Encaissement PWA
// Network-first so deploys propagate immediately.
// API calls are network-only (payments must always be live).
const CACHE = 'academie-encaissement-v1';
const SHELL = ['/encaissement', '/manifest-encaissement.json', '/icons/icon-192.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API / auth calls: network-only (payments must always be live)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell: network-first, fall back to cache for offline resilience.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

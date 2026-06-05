// Service Worker — L'Académie Appel PWA
// Network-first for app shell so deploys propagate immediately.
// API calls are network-only (attendance must always be live).
// Bump CACHE version on every deploy that changes appel.html or shell assets.
const CACHE = 'academie-appel-v7';
const SHELL = ['/appel', '/manifest.json', '/icons/icon-192.svg'];

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

  // API / auth calls: network-only (attendance must always be live)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell: network-first, fall back to cache for offline resilience.
  // Prevents stale cached pages from persisting across deploys.
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

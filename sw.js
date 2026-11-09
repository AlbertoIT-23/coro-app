// Network first, so a new version shows up at once; the cache only covers being offline.
const CACHE = 'coro-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        const copy = response.clone();
        if (response.ok) caches.open(CACHE).then((c) => c.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

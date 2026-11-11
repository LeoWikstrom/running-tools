// App-shell cache only: same-origin assets. Map/terrain/Overpass requests are
// cross-origin and handled by their own caches (IndexedDB) or the network.
const CACHE = 'profile-course-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;

  // The cache write is awaited before the response resolves: a floating put
  // can be killed with the service worker between response and write, leaving
  // a stale shell for the next offline visit. A failed put (quota) must not
  // discard a good network response, hence its own catch.
  const putThenRespond = (res) =>
    caches
      .open(CACHE)
      .then((c) => c.put(event.request, res.clone()))
      .catch(() => undefined)
      .then(() => res);

  if (event.request.mode === 'navigate') {
    // Network-first so new deploys are picked up; cached shell when offline.
    event.respondWith(
      fetch(event.request)
        .then(putThenRespond)
        .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('./'))),
    );
    return;
  }

  // Hashed assets: cache-first.
  event.respondWith(
    caches
      .match(event.request)
      .then(
        (hit) =>
          hit ?? fetch(event.request).then((res) => (res.ok ? putThenRespond(res) : res)),
      ),
  );
});

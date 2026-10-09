// sw.js - lets the phone build run offline once it has been played.
//
// Network first, always: a phone with a connection gets the latest game every
// time (so an update never hides behind a stale cache), and every file it
// fetches - the pages, the shared code and data one folder up, and Three.js,
// Rapier and the fonts from their CDNs - is kept, so with no connection the
// game comes from the cache instead.
const CACHE = "robo-league-mobile-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Keep good answers (and the CDNs' opaque ones) for next time offline.
      if (res && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
      if (hit) return hit;
      throw err;
    }
  })());
});

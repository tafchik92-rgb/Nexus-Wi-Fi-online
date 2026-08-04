/* ============================================================
   NEXUS//POS — service worker

   Makes the till launchable quickly and repeatedly: the app shell is
   cached on install and served from cache first, so a phone in a mine
   camp opens the terminal instantly whether or not there is signal.

   The Firebase SDK is cached too. Those URLs carry the version in the
   path (…/firebasejs/10.14.1/…), so they are immutable — re-fetching
   ~1.5MB on every launch was the single biggest cause of a phone sitting
   on a blank screen. Live Firebase traffic is never cached: only the
   SDK's own script files match.

   Everything else cross-origin goes straight to the network.
   ============================================================ */
const VERSION = "nexus-pos-/*__BUILD_TIME__*/";
// The Firebase SDK, kept in its own cache so an app upgrade does not throw
// away 1.5MB that is still perfectly valid.
const SDK_CACHE = "nexus-pos-sdk";
const SDK_URL = /^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-[a-z-]+\.js$/;
const SHELL = [
  "./", "./index.html", "./styles.css",
  "./firebase-config.js", "./importer.js", "./backend.js",
  "./core.js", "./admin.js", "./agent.js", "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
  // Vite renames styles.css to a hashed asset; the build injects the real
  // names here so a first offline launch is fully styled. Serving the plain
  // static files instead, styles.css below is the one that exists.
  "./styles.css",
  /*__BUILD_ASSETS__*/
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // Individual misses must not fail the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== SDK_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Version-pinned SDK files: cache-first and never revalidated, because a
  // given URL can only ever return one thing. This is what makes the second
  // and every later launch fast.
  if (SDK_URL.test(url.href)) {
    e.respondWith(
      caches.open(SDK_CACHE).then((c) => c.match(request).then((hit) => hit || fetch(request).then((res) => {
        // Only store something that is actually script. A captive portal —
        // exactly what a Wi-Fi shop's own guests sit behind — answers 200 with
        // an HTML login page, and caching that would break the app on this
        // device permanently, long after the network was fixed.
        const type = res && res.headers ? (res.headers.get("content-type") || "") : "";
        if (res && res.ok && /javascript|ecmascript/i.test(type)) c.put(request, res.clone());
        return res;
      })))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;   // live Firebase traffic: never cached

  e.respondWith(
    caches.match(request).then((hit) => {
      // Serve instantly from cache, then quietly refresh it for next launch.
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit || caches.match("./index.html"));
      return hit || network;
    })
  );
});

/* ============================================================
   NEXUS//POS — service worker

   The app's own files are fetched from the network first, with the cache
   as the fallback when there is no answer. Cache-first was faster but
   silently wrong: the cache name only changes when the build stamps it,
   and a static deploy never does — so a device that had once cached the
   app kept running the old JavaScript after every release. An agent on a
   stale build made the wrong database queries and saw nothing, while an
   administrator on the same device worked, because the old queries were
   ones only an administrator is allowed to make.

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
  "./version.js", "./firebase-config.js", "./importer.js", "./backend.js",
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

// How long to wait for the network before falling back to the cached shell.
// Long enough to prefer fresh code on a slow link, short enough that a dead
// connection does not hold the launch.
const NETWORK_TIMEOUT = 2500;

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

  // The app's own "is there a newer build?" probe. Its URL is unique every
  // time, so caching it would grow the cache without bound and never be read
  // again — and the whole point of the request is to reach the server.
  if (url.searchParams.has("fresh")) return;

  // Network first for the app's own code, so a deploy takes effect on the
  // very next launch and two files from different releases can never run
  // together. The cache is what makes the till open without a signal.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([
        fetch(request),
        new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), NETWORK_TIMEOUT)),
      ]);
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    } catch (_) {
      const hit = await cache.match(request);
      if (hit) return hit;
      // A navigation with nothing cached for it still gets the shell.
      if (request.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      throw new Error("offline and not cached: " + url.pathname);
    }
  })());
});

/* ============================================================
   NEXUS//POS — service worker

   Makes the till launchable with no connection: the app shell is
   cached on install and served from cache first, so a phone in a mine
   camp opens the terminal instantly whether or not there is signal.

   Only same-origin app files are cached. Firebase traffic and the CDN
   SDK always go to the network, so nothing stale is ever served for
   live data or authentication.
   ============================================================ */
const VERSION = "nexus-pos-v2";
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
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Firebase + CDN: never cached

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

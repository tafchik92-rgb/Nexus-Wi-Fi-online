/* ============================================================
   NEXUS//POS — build identity

   One place that answers "which version is this till actually running?".

   That question is not cosmetic here. The app ships as plain scripts a
   service worker caches, so a device can keep running last month's code
   long after a deploy — and the symptom is never "you are out of date",
   it is an agent seeing an empty till while an administrator on the same
   device is fine. Until now the header simply read "v2.0", hard-coded,
   which said the same thing on every build and so proved nothing.

   Two numbers, because they answer different questions:

     RELEASE  a human number, bumped by hand when a release lands. What
              you say out loud: "they're on 2.2".
     BUILD    a UTC stamp written by the build. Changes on every deploy,
              so two devices showing the same build really are running
              the same code.

   The stamp is substituted by both `npm run build` and `deploy.sh`,
   because the app is deployed both ways (Firebase Hosting serves the
   source tree directly). Served straight from a source checkout neither
   has run, so the stamp keeps its placeholder and the app says SOURCE
   rather than inventing a version.
   ============================================================ */

// Bumped by hand. Keep in step with package.json.
const APP_RELEASE = "2.2";

// Rewritten in place by vite.config.ts and deploy.sh — the whole line is
// matched, so do not reformat it.
const APP_BUILD = "__BUILD_STAMP__";

const AppVersion = (function () {
  const STAMP = /^\d{8}-\d{6}$/;
  const stamped = STAMP.test(APP_BUILD);
  const build = stamped ? APP_BUILD : "";

  // YYYYMMDD-HHMMSS, written in UTC, shown in the till's own timezone.
  const builtAt = stamped
    ? new Date(Date.UTC(
        +APP_BUILD.slice(0, 4), +APP_BUILD.slice(4, 6) - 1, +APP_BUILD.slice(6, 8),
        +APP_BUILD.slice(9, 11), +APP_BUILD.slice(11, 13), +APP_BUILD.slice(13, 15)))
    : null;

  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const pad = (n) => String(n).padStart(2, "0");
  const builtLabel = builtAt
    ? `${pad(builtAt.getDate())} ${MONTHS[builtAt.getMonth()]} ${builtAt.getFullYear()} · ${pad(builtAt.getHours())}:${pad(builtAt.getMinutes())}`
    : "";

  const api = {
    release: APP_RELEASE,
    build,
    stamped,
    builtAt,
    builtLabel,
    // Short, for the header.
    label: `v${APP_RELEASE}`,
    // Long, for anywhere with room to explain itself.
    full: stamped ? `v${APP_RELEASE} · BUILD ${build}` : `v${APP_RELEASE} · SOURCE`,
    // Set once a check has found a newer build on the server.
    latest: null,
  };

  api.updateAvailable = () => !!(api.latest && api.latest.build && api.latest.build !== build);

  /* ----------------------------------------------------------
     What the service worker is holding

     The worker names its cache after the same stamp. Reading that back
     is how you tell a till that has *downloaded* a new release from one
     that is still being served the old one by its own worker — the
     failure that looked like a backend problem for a whole afternoon.
     ---------------------------------------------------------- */
  api.workerBuild = async function () {
    if (!("caches" in self)) return null;
    try {
      const keys = await caches.keys();
      // Activation deletes the old ones, so normally there is exactly one.
      // Sorted anyway, because the stamps sort chronologically and a worker
      // caught mid-changeover should report the newer of the two.
      const hit = keys.filter((k) => k.startsWith("nexus-pos-") && k !== "nexus-pos-sdk").sort();
      return hit.length ? hit[hit.length - 1].replace("nexus-pos-", "") : null;
    } catch (_) { return null; }
  };

  /* ----------------------------------------------------------
     Is there a newer build on the server?

     Re-fetches this very file and reads the stamp out of it. `fresh=1`
     defeats three caches at once: the browser's (no-store), Hosting's
     one-hour max-age on .js (the query string is new every time, so the
     CDN cannot answer from an existing entry), and the app's own service
     worker, which is told to leave `fresh` requests alone.
     ---------------------------------------------------------- */
  let checking = null;
  api.checkForUpdate = function () {
    if (checking) return checking;                       // one probe in flight, not one per caller
    checking = (async () => {
      try {
        const res = await fetch(`version.js?fresh=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return null;
        const src = await res.text();
        // Both declarations sit at the top of the file, so the first match
        // is always the declaration and never this probe's own source.
        const b = src.match(/const APP_BUILD = "([^"]*)"/);
        const r = src.match(/const APP_RELEASE = "([^"]*)"/);
        if (!b || !STAMP.test(b[1])) return null;        // unstamped server: nothing to compare
        api.latest = { build: b[1], release: r ? r[1] : APP_RELEASE };
        return api.latest;
      } catch (_) {
        return null;                                     // offline is not an update
      }
    })().finally(() => { checking = null; });
    return checking;
  };

  /* ----------------------------------------------------------
     Watch for a release landing mid-shift

     A till stays open all day, so an update deployed at noon would
     otherwise not be noticed until somebody happened to reload. Checked
     on a slow timer and whenever the tab is looked at again, throttled so
     switching apps on a phone does not hammer the network.
     ---------------------------------------------------------- */
  const EVERY = 15 * 60 * 1000;
  let last = 0;
  api.watch = function (onUpdate) {
    const run = async () => {
      if (Date.now() - last < 60 * 1000) return;         // never more than once a minute
      last = Date.now();
      await api.checkForUpdate();
      if (api.updateAvailable() && typeof onUpdate === "function") onUpdate(api.latest);
    };
    setInterval(run, EVERY);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) run(); });
    run();
  };

  /* ----------------------------------------------------------
     Take the update

     A plain reload is not reliably enough. Hosting serves the app's
     scripts with an hour of cache life, so for that hour a reload can be
     answered from the browser's own HTTP cache with the very code the
     update is meant to replace — the marker would go on saying "update
     available" while tapping it appeared to do nothing.

     `cache: "reload"` bypasses that cache and rewrites its entries, so
     the fetches that follow — the service worker re-caching the shell,
     then the page loading it — all see the new build. Warming them here
     also means the till is offline-ready on the new version immediately
     rather than after a second launch.

     Kept in step with SHELL in sw.js.
     ---------------------------------------------------------- */
  const APP_FILES = [
    "index.html", "styles.css", "version.js", "firebase-config.js",
    "importer.js", "backend.js", "core.js", "admin.js", "agent.js", "app.js",
  ];

  api.applyUpdate = async function () {
    try {
      await Promise.allSettled(APP_FILES.map((f) => fetch(f, { cache: "reload" })));
    } catch (_) { /* a warm-up that fails still leaves the reload to try */ }
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
    } catch (_) { /* an update that cannot be prefetched still reloads */ }
    location.reload();
  };

  return api;
})();

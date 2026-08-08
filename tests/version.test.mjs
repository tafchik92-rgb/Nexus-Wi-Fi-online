/* ============================================================
   The version marker.

   The app is cached by a service worker and served with an hour of
   HTTP cache life, so "is this till on the current build?" is not a
   question anyone can answer by looking. It has already cost an
   afternoon: an agent on stale code saw an empty till while an
   administrator on the same device was fine.

   So the marker has to do more than print a number. These checks hold
   it to that:

     · it names the build, not a hand-typed constant
     · it says SOURCE rather than inventing one when nothing stamped it
     · it notices a release deployed while the till is open
     · tapping it actually lands the till on the new build — through an
       hour of Cache-Control, which is where a naive reload fails
     · the probe it uses does not fill the offline cache

   Serves its own copy of the app so a deploy can happen mid-test, with
   the same caching headers Firebase Hosting uses.

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     node tests/version.test.mjs
   ============================================================ */

import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
let chromium;
for (const spec of ['playwright', '/opt/pw-browsers/../node_modules/playwright/index.mjs',
                    '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('Playwright not installed — skipping.'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'nexus-pos-fn-test';
const SDK_DIR = process.env.NEXUS_SDK_MIRROR || '';
const say = console.log;

let failures = 0;
const check = (ok, label, detail) => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`   ${detail}`);
  if (!ok) failures++;
};

/* ---------- a site we can redeploy underneath the browser ---------- */
const SITE = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'nexusver-'));
const FILES = ['index.html', 'styles.css', 'version.js', 'sw.js', 'firebase-config.js',
               'importer.js', 'backend.js', 'core.js', 'admin.js', 'agent.js', 'app.js',
               'manifest.webmanifest'];
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
fs.mkdirSync(path.join(SITE, 'icons'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'icons'))) {
  fs.copyFileSync(path.join(ROOT, 'icons', f), path.join(SITE, 'icons', f));
}

// The same substitution deploy.sh performs.
const deploy = (stamp, release) => {
  const v = fs.readFileSync(path.join(ROOT, 'version.js'), 'utf8')
    .replace(/const APP_BUILD = "[^"]*";/, `const APP_BUILD = "${stamp}";`)
    .replace(/const APP_RELEASE = "[^"]*";/, `const APP_RELEASE = "${release}";`);
  fs.writeFileSync(path.join(SITE, 'version.js'), v);
  const s = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')
    .replace(/const VERSION = "nexus-pos-[^"]*";/, `const VERSION = "nexus-pos-${stamp}";`);
  fs.writeFileSync(path.join(SITE, 'sw.js'), s);
};

const BUILD_A = '20260101-090000';
const BUILD_B = '20260202-181500';

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let served = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(SITE, p);
  served.push(req.url);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  const ext = path.extname(file);
  // Firebase Hosting's own header for this project. The point of the test.
  const cache = /\.(js|css)$/.test(file) ? 'max-age=3600' : 'no-cache';
  res.writeHead(200, { 'content-type': TYPES[ext] || 'text/plain', 'cache-control': cache });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

const open = async ({ sw = false } = {}) => {
  const ctx = await b.newContext(sw ? {} : { serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => say('   PAGEERROR: ' + e.message));
  if (SDK_DIR && fs.existsSync(SDK_DIR)) {
    await p.route(/gstatic\.com\/firebasejs\//, (r) => {
      const f = path.join(SDK_DIR, r.request().url().split('/').pop());
      if (!fs.existsSync(f)) return r.abort();
      r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
    });
  }
  await p.route('**/firebase-config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: `window.NEXUS_FIREBASE_CONFIG = ${JSON.stringify({ apiKey: 'fake-api-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, useEmulators: true, emulatorHost: '127.0.0.1' })};` }));
  await p.goto(`${ORIGIN}/index.html`); await p.waitForTimeout(3200);
  return p;
};

/* ============================================================
   1. An unstamped source checkout says so
   ============================================================ */
fs.copyFileSync(path.join(ROOT, 'version.js'), path.join(SITE, 'version.js'));
{
  const p = await open();
  const foot = (await p.locator('#login-version').innerText()).trim();
  check(/SOURCE/.test(foot) && !/BUILD/.test(foot),
    'an unstamped checkout says SOURCE rather than inventing a build', foot);
  await p.context().close();
}

/* ============================================================
   2. A stamped build names itself, before anyone signs in
   ============================================================ */
deploy(BUILD_A, '2.1');
const A = await open();
{
  const foot = (await A.locator('#login-version').innerText()).trim();
  check(foot.includes(BUILD_A) && foot.includes('v2.1'),
    'the sign-in screen names the build this device is running', foot);
}

/* ---------- sign in so the header and CLOUD panel are reachable ---------- */
await A.click('[data-action=show-setup]'); await A.waitForTimeout(300);
await A.fill('#st-name', 'Ada Mensah'); await A.fill('#st-code', 'ADM-01');
await A.fill('#st-pin', '1234'); await A.fill('#st-site', 'Gloy Mine Camp');
await A.click('#setup-form button[type=submit]'); await A.waitForTimeout(5000);

{
  const label = (await A.locator('#app-version').innerText()).trim();
  const title = await A.locator('#app-version').getAttribute('title');
  check(label === 'v2.1' && title.includes(BUILD_A),
    'the header carries the release, with the build behind it',
    `${label} — title: ${title}`);
}

/* ============================================================
   3. The admin CLOUD panel reports it too
   ============================================================ */
await A.click('.subtab[data-sub=cloud]'); await A.waitForTimeout(900);
{
  const sum = (await A.locator('#cloud-summary').innerText()).replace(/\n+/g, ' | ');
  check(sum.includes('APP VERSION') && sum.includes(BUILD_A),
    'the admin CLOUD panel reports the running build', sum.split(' | ').slice(0, 3).join(' | '));
}

/* ============================================================
   4. Clean diagnostics while the till is on the current build
   ============================================================ */
await A.click('#btn-cloud-diag'); await A.waitForTimeout(4000);
{
  const first = (await A.locator('#diag-list .diag-row').first().innerText()).replace(/\n+/g, ' — ');
  const level = await A.locator('#diag-list .diag-row').first().getAttribute('class');
  check(/App version/.test(first) && /diag-ok/.test(level),
    'diagnostics open on the version, and it passes when current', first);
  await A.click('#diag-close');
}

/* ============================================================
   5. A release lands while the till is open
   ============================================================ */
deploy(BUILD_B, '2.2');
say(`\n--- deployed v2.2 (${BUILD_B}) while the till stayed open ---\n`);

const found = await A.evaluate(async () => {
  const latest = await AppVersion.checkForUpdate();
  renderVersion();
  return latest;
});
{
  const label = (await A.locator('#app-version').innerText()).trim();
  const cls = await A.locator('#app-version').getAttribute('class');
  check(found && found.build === BUILD_B, 'the open till notices the new build without being reloaded',
    JSON.stringify(found));
  check(/UPDATE/.test(label) && /is-stale/.test(cls),
    'the marker turns into the way to take it', `${label} (${cls})`);
}

await A.click('.subtab[data-sub=cloud]'); await A.waitForTimeout(600);
{
  const sum = (await A.locator('#cloud-summary').innerText()).replace(/\n+/g, ' | ');
  check(/released/.test(sum), 'the CLOUD panel says a newer release is out', sum.split(' | ')[0]);
}

await A.click('#btn-cloud-diag'); await A.waitForTimeout(4000);
{
  const first = (await A.locator('#diag-list .diag-row').first().innerText()).replace(/\n+/g, ' — ');
  const level = await A.locator('#diag-list .diag-row').first().getAttribute('class');
  check(/diag-warn/.test(level) && first.includes(BUILD_B),
    'diagnostics name the deployed build and how to get onto it', first);

  // The header used to count failures only, so it could say ALL CLEAR with
  // an amber row sitting directly under it.
  const sum = (await A.locator('#diag-summary').innerText()).trim();
  check(/WARNING/.test(sum) && !/ALL CLEAR/.test(sum),
    'and the summary does not claim all clear over a warning', sum);
  await A.click('#diag-close'); await A.waitForTimeout(300);
}

/* ============================================================
   6. Tapping it lands the till on the new build
   ============================================================ */
await A.click('#app-version');
await A.waitForTimeout(6000);
{
  const running = await A.evaluate(() => ({ release: AppVersion.release, build: AppVersion.build }));
  check(running.build === BUILD_B && running.release === '2.2',
    'tapping it lands the till on the new build',
    JSON.stringify(running));

  const label = (await A.locator('#app-version').innerText()).trim();
  const cls = await A.locator('#app-version').getAttribute('class') || '';
  check(label === 'v2.2' && !/is-stale/.test(cls),
    'and the marker goes quiet once it is current', `${label} (${cls || 'no state'})`);
}

/* ============================================================
   7. The update probe does not fill the offline cache

   Its URL is unique every time, so a service worker that cached it
   would grow without bound and never read a single entry back.
   ============================================================ */
{
  const P = await open({ sw: true });
  await P.waitForTimeout(2500);
  await P.evaluate(() => AppVersion.checkForUpdate());
  await P.waitForTimeout(1500);

  const state = await P.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.filter((k) => k.startsWith('nexus-pos-') && k !== 'nexus-pos-sdk');
    let fresh = 0;
    for (const k of shell) {
      const reqs = await (await caches.open(k)).keys();
      fresh += reqs.filter((r) => r.url.includes('fresh=')).length;
    }
    return { shell, fresh, worker: await AppVersion.workerBuild() };
  });

  check(state.fresh === 0, 'the update probe is never written to the offline cache',
    `${state.fresh} probe responses cached across ${state.shell.length} shell cache(s)`);
  check(state.worker === BUILD_B,
    'the worker names the build it is holding, so a stale shell is visible',
    `worker holds ${state.worker}`);
  await P.context().close();
}

const probes = served.filter((u) => u.includes('fresh=')).length;
say(`\n(the page made ${probes} cache-busting probes; every one reached the server)`);

/* ============================================================
   8. The trap the update path exists to get past

   Hosting gives .js an hour of cache life, and a reload does not
   re-fetch subresources — it only revalidates the page itself. So a
   plain reload after a deploy can re-run the very code the deploy
   replaced, and the marker would sit there saying UPDATE while tapping
   it appeared to do nothing.

   This runs with no request routing on the page, because intercepting
   requests turns the browser cache off — which is exactly what would
   let a broken update path pass a test.
   ============================================================ */
{
  const BUILD_C = '20260303-120000';
  fs.writeFileSync(path.join(SITE, 'firebase-config.js'), '/* no shop configured */');

  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/index.html`); await p.waitForTimeout(2500);
  const before = await p.evaluate(() => AppVersion.build);

  deploy(BUILD_C, '2.3');

  await p.reload(); await p.waitForTimeout(1500);
  const afterPlain = await p.evaluate(() => AppVersion.build);
  check(afterPlain === before,
    'a plain reload really is answered from cache — the trap is real, not theoretical',
    `deployed ${BUILD_C}, reload still running ${afterPlain}`);

  await p.evaluate(() => AppVersion.applyUpdate()).catch(() => {});
  await p.waitForTimeout(4000);
  const afterUpdate = await p.evaluate(() => AppVersion.build);
  check(afterUpdate === BUILD_C,
    'the update path gets past it where a reload cannot',
    `now running ${afterUpdate}`);
  await ctx.close();
}

await b.close();
server.close();
fs.rmSync(SITE, { recursive: true, force: true });

say(failures === 0 ? '\nversion suite passed' : `\nversion suite: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

/* ============================================================
   A device that already cached the app, when a new release lands.

   The fault this guards: the service worker's cache name only changes
   when a build stamps it, and a static deploy never does. Cache-first
   then served the previous release indefinitely. A newly created agent
   on stale code made whole-collection queries the rules refuse and saw
   an empty till — while an administrator on the same device worked
   fine, because those are queries only an administrator may make. That
   is why "sign in as admin once, then sign out" appeared to fix it.

   Usage:
     npx serve -l 4210 <a copy of the app>     (this suite manages it)
     node tests/staleworker.test.mjs
   ============================================================ */
import fs from 'node:fs'; import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('Playwright not installed — skipping.'); process.exit(0); }

const APP = path.resolve(import.meta.dirname, '..');
const SDK_DIR = process.env.NEXUS_SDK_MIRROR || '';
// A free port picked per run: this suite serves its own throwaway copy of
// the app, and two runs on a fixed port would fight over it.
const PORT = Number(process.env.NEXUS_SIM_PORT || 0) ||
  (4300 + Math.floor(Math.random() * 600));
const ORIGIN = `http://127.0.0.1:${PORT}`;

// A throwaway copy of the app we can "deploy" over, mid-test.
const SIM = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sw-'));
for (const f of ['index.html','styles.css','sw.js','manifest.webmanifest','importer.js',
                 'core.js','admin.js','agent.js','app.js','backend.js','firebase-config.js']) {
  fs.copyFileSync(path.join(APP, f), path.join(SIM, f));
}
fs.mkdirSync(path.join(SIM, 'icons'), { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'icons'))) {
  fs.copyFileSync(path.join(APP, 'icons', f), path.join(SIM, 'icons', f));
}

// The "previous release": the same app, but listening to whole collections
// the way it did before agent queries were scoped.
const current = fs.readFileSync(path.join(SIM, 'backend.js'), 'utf8');
const a = current.indexOf('    const plan = this.syncPlan(role, mySites, user.uid);');
const b2 = current.indexOf('    const streams = plan.filter');
if (a === -1 || b2 === -1) { console.log('FAIL  could not build the old release — startSync has changed shape'); process.exit(1); }
const previous = current.slice(0, a)
  + '    const plan = Object.keys(COLLECTIONS).map((key) => ({ key, coll: COLLECTIONS[key], constraints: [] }));\n'
  + current.slice(b2);

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: SIM, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch (_) {} fs.rmSync(SIM, { recursive: true, force: true }); };
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const step = async (n, f) => { try { await f(); console.log('PASS  ' + n); } catch (e) { console.log('FAIL  ' + n + ' → ' + String(e.message).split('\n')[0]); process.exitCode = 1; } };

const ctx = await browser.newContext({ serviceWorkers: 'allow' });   // the point of the suite
const p = await ctx.newPage();
if (SDK_DIR && fs.existsSync(SDK_DIR)) {
  await p.route(/gstatic\.com\/firebasejs\//, (r) => {
    const f = path.join(SDK_DIR, r.request().url().split('/').pop());
    if (!fs.existsSync(f)) return r.abort();
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
  });
}
await p.route('**/firebase-config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
  body: 'window.NEXUS_FIREBASE_CONFIG = { apiKey: "fake-api-key", projectId: "nexus-pos-fn-test", useEmulators: true, emulatorHost: "127.0.0.1" };' }));

const running = () => p.evaluate(() =>
  /this\.syncPlan\(role, mySites/.test(String(Backend.startSync)) ? 'new' : 'old');

await step('a device caches the app on the release it first sees', async () => {
  fs.writeFileSync(path.join(SIM, 'backend.js'), previous);
  await p.goto(ORIGIN + '/index.html'); await p.waitForTimeout(4000);
  const reg = await p.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && (r.active || r.installing));
  });
  if (!reg) throw new Error('no service worker registered');
  if (await running() !== 'old') throw new Error('did not start on the old release');
  await p.waitForTimeout(2500);   // let it cache the shell
});

await step('the very next launch after a deploy runs the new code', async () => {
  fs.writeFileSync(path.join(SIM, 'backend.js'), current);
  await p.goto(ORIGIN + '/index.html'); await p.waitForTimeout(5000);
  const which = await running();
  if (which !== 'new') {
    throw new Error('still running the previous release — an agent here would query as the old build did and be refused');
  }
});

await step('and it stays on the new code, not flapping back', async () => {
  await p.goto(ORIGIN + '/index.html'); await p.waitForTimeout(4000);
  if (await running() !== 'new') throw new Error('reverted to the old release');
});

await browser.close();
stop();
console.log(process.exitCode === 1 ? '\nstale-worker suite FAILED' : '\nstale-worker suite passed');

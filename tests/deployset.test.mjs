/* ============================================================
   What a hosting deploy actually ships.

   Hosting serves the repository root, so `ignore` in firebase.json is
   the only thing standing between the app and everything else in the
   working directory. It was missing `*.log`, and a deploy that had run
   before left a 97 MB firebase-debug.log next to a 46 MB
   firestore-debug.log — so a 318 KB app was uploaded as 145 MB, and the
   deploy died on one file after six upload retries.

   An ignore list is easy to tighten too far, and the failure then is far
   worse than a slow deploy: the app goes up missing a script and every
   till breaks at once. So this derives the shipped set from firebase.json
   itself, serves only that, and boots the app on it.

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     node tests/deployset.test.mjs
   ============================================================ */

import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
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

/* ---------- the file list, straight out of firebase.json ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const IGN = cfg.hosting.ignore;

// Mirrors the glob shapes the ignore list actually uses. Deliberately simple:
// a clever matcher here that disagreed with the real one would defeat the
// point of the test.
const ignored = (rel) => IGN.some((pat) => {
  if (pat === '**/.*') return rel.split('/').some((p) => p.startsWith('.'));
  if (pat === '**/node_modules/**') return `${rel}/`.includes('node_modules/');
  if (pat.startsWith('**/*.')) return rel.endsWith(pat.slice(4));
  if (pat.endsWith('/**')) return rel === pat.slice(0, -3) || rel.startsWith(`${pat.slice(0, -3)}/`);
  if (pat.startsWith('*.')) return !rel.includes('/') && rel.endsWith(pat.slice(1));
  return rel === pat;
});

const shipped = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir || '.'), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (ignored(rel)) continue;
    if (e.isDirectory()) walk(rel); else shipped.push(rel);
  }
})('');

const bytes = shipped.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);
say(`firebase.json ships ${shipped.length} files, ${(bytes / 1024).toFixed(0)} KB\n`);

/* ---------- nothing the app needs at runtime may be missing ---------- */
// index.html names its own scripts, and sw.js names what it precaches for an
// offline launch. Read from the files rather than listed here, so a new script
// is covered the day it is added.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fromHtml = [...html.matchAll(/(?:src|href)="\.?\/?([^"#:]+?)"/g)]
  .map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('http'));
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const shellStart = sw.indexOf('const SHELL');
const fromSw = [...sw.slice(shellStart, sw.indexOf('];', shellStart)).matchAll(/"\.\/([^"]+)"/g)]
  .map((m) => m[1]).filter((f) => f && !f.startsWith('assets/'));

const need = [...new Set([...fromHtml, ...fromSw])];
const missing = need.filter((f) => !shipped.includes(f));
check(missing.length === 0,
  'every file index.html and the service worker ask for is deployed',
  missing.length ? `missing: ${missing.join(', ')}` : `${need.length} runtime files, all present`);

/* ---------- and the things that should never be published are not ---------- */
const banned = shipped.filter((f) =>
  f.endsWith('.log') || f.startsWith('dist/') || f.startsWith('tests/')
  || f.startsWith('functions/') || f.includes('node_modules/')
  || f === 'deploy.sh' || f === 'firestore.rules');
check(banned.length === 0,
  'logs, build output, tests and the deploy script stay off the web',
  banned.length ? `would be published: ${banned.join(', ')}` : 'none of them ship');

/* ---------- the shipped set is a working app ---------- */
const SITE = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'deployset-'));
for (const f of shipped) {
  fs.mkdirSync(path.join(SITE, path.dirname(f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
}

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const missed = [];
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(SITE, p === '/' ? 'index.html' : p);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    missed.push(p); res.writeHead(404); return res.end('not deployed');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
if (SDK_DIR && fs.existsSync(SDK_DIR)) {
  await p.route(/gstatic\.com\/firebasejs\//, (r) => {
    const f = path.join(SDK_DIR, r.request().url().split('/').pop());
    if (!fs.existsSync(f)) return r.abort();
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
  });
}
await p.route('**/firebase-config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
  body: `window.NEXUS_FIREBASE_CONFIG = ${JSON.stringify({ apiKey: 'fake-api-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, useEmulators: true, emulatorHost: '127.0.0.1' })};` }));
await p.goto(`${ORIGIN}/index.html`); await p.waitForTimeout(4000);

check(missed.length === 0, 'the app asks for nothing the deploy left behind',
  missed.length ? `404s: ${[...new Set(missed)].join(', ')}` : 'no 404s');
check(errors.length === 0, 'it boots with no script errors',
  errors.length ? errors.join(' | ') : 'clean');

// Setting up a shop is the first thing a new deploy has to be able to do.
await p.click('[data-action=show-setup]'); await p.waitForTimeout(300);
await p.fill('#st-name', 'Ada Mensah'); await p.fill('#st-code', 'ADM-01');
await p.fill('#st-pin', '1234'); await p.fill('#st-site', 'Gloy Mine Camp');
await p.click('#setup-form button[type=submit]');
let opened = true;
await p.waitForSelector('#app:not([hidden])', { timeout: 40000 }).catch(() => { opened = false; });
check(opened, 'and a shop can be set up and signed into on it',
  opened ? 'the workspace opened' : (await p.locator('#setup-err').innerText().catch(() => 'no error shown')));

await b.close();
server.close();
fs.rmSync(SITE, { recursive: true, force: true });
say(failures === 0 ? '\ndeploy-set suite passed' : `\ndeploy-set suite: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

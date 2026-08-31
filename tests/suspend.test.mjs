/* ============================================================
   Suspending someone stops the shift they are already in.

   Role and site scope ride in a signed token that stays valid for up to
   an hour, and the rules used to read nothing else — so suspending an
   agent who was already signed in did nothing at all. They kept issuing
   vouchers and taking customers' money, and the suspension only bit when
   they happened to sign out. For a shop that suspends someone because
   money has gone missing, "effective at their convenience" is no control.

   Two halves are checked here, because either alone is not enough:

     the boundary  the rules refuse a suspended member's writes, whatever
                   their token says (proved exhaustively in rules.test)
     the till      the screen in front of them closes and says why, rather
                   than going on taking orders and failing at the last
                   step — an agent watching COMPLETE SALE bounce with no
                   explanation assumes the app is broken and keeps trying

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     npx serve -l 4199 .
     node tests/suspend.test.mjs
   ============================================================ */

import fs from 'node:fs'; import path from 'node:path';
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('Playwright not installed — skipping.'); process.exit(0); }

const PROJECT = 'nexus-pos-fn-test';
const SDK_DIR = process.env.NEXUS_SDK_MIRROR || '';
const ORIGIN = process.env.NEXUS_ORIGIN || 'http://127.0.0.1:4199';
const REST = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const say = console.log;
let failures = 0;
const step = async (n, f) => {
  try { await f(); say('PASS  ' + n); }
  catch (e) { say('FAIL  ' + n + ' → ' + String(e.message).split('\n')[0]); failures++; }
};
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};

const open = async (label) => {
  const ctx = await b.newContext({ serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => say(`   [${label}] PAGEERROR: ` + e.message));
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

// what the server actually holds, independent of any screen
const serverSales = async () => {
  const r = await fetch(`${REST}/sales`, { headers: { Authorization: 'Bearer owner' } });
  const j = await r.json();
  return (j.documents || []).length;
};

/* ---------- the shop ---------- */
const A = await open('admin');
await A.click('[data-action=show-setup]'); await A.waitForTimeout(300);
await A.fill('#st-name', 'Ada Mensah'); await A.fill('#st-code', 'ADM-01');
await A.fill('#st-pin', '1234'); await A.fill('#st-site', 'Gloy Mine Camp');
// Waited on rather than slept through: the first call after the emulator
// starts is a cold start, and a fixed delay makes that look like a bug here.
await A.click('#setup-form button[type=submit]');
await A.waitForSelector('#app:not([hidden])', { timeout: 40000 });
await A.waitForTimeout(1500);
const siteId = await A.evaluate(() => db.sites[0].id);

await A.click('.subtab[data-sub=vouchers]'); await A.waitForTimeout(700);
await A.fill('#up-codes', ['W5-A', 'W5-B', 'W5-C', 'W5-D'].join('\n'));
await A.click('#voucher-form button[type=submit]'); await A.waitForTimeout(2500);

await A.click('.subtab[data-sub=team]'); await A.waitForTimeout(700);
await A.fill('#u-name', 'Kira Vance'); await A.fill('#u-code', 'AG-01');
await A.selectOption('#u-role', 'agent'); await A.fill('#u-pin', '1111'); await A.waitForTimeout(400);
await A.check(`#u-sites input[value="${siteId}"]`);
await A.click('#user-form button[type=submit]'); await A.waitForTimeout(3000);

/* ---------- the agent is mid-shift ---------- */
const G = await open('agent');
await G.fill('#lg-code', 'AG-01'); await G.fill('#lg-pin', '1111');
await G.click('#login-form button[type=submit]');
await G.waitForSelector('#app:not([hidden])', { timeout: 40000 });
await G.waitForTimeout(2000);

await step('the agent is signed in and selling', async () => {
  await G.click('.tab[data-tab=terminal]'); await G.waitForTimeout(800);
  await G.click('.pkg[data-vtype=V5]');
  await G.fill('#c-name', 'Amina Diallo');
  await G.click('#btn-complete'); await G.waitForTimeout(3500);
  await G.click('#btn-new-sale'); await G.waitForTimeout(1200);
  eq(await serverSales(), 1, 'sales on the server');
  eq(await G.evaluate(() => $('#app').hidden), false, 'the till is open');
});

const soldBefore = await serverSales();

/* ---------- the administrator suspends them ---------- */
await A.click('.subtab[data-sub=team]'); await A.waitForTimeout(800);
await A.locator('[data-action=toggle-user]').first().click();
await A.waitForTimeout(2500);

await step('the administrator sees them as suspended', async () => {
  const row = await A.locator('#team-tbody tr').filter({ hasText: 'AG-01' }).innerText();
  if (!/INACTIVE/i.test(row)) throw new Error(`roster row reads: ${row.replace(/\n+/g, ' | ')}`);
});

/* ---------- the till closes itself ---------- */
await step('the agent\'s till closes itself, without them touching it', async () => {
  await G.waitForSelector('#login:not([hidden])', { timeout: 15000 });
  eq(await G.evaluate(() => $('#app').hidden), true, 'the workspace is gone');
});

await step('and it says why, rather than just failing', async () => {
  const err = (await G.locator('#login-err').innerText()).trim();
  if (!/suspended/i.test(err)) throw new Error(`the sign-in screen says: "${err}"`);
  say(`   "${err}"`);
});

await step('the shift\'s records are off the screen with them', async () => {
  const left = await G.evaluate(() => ({
    sales: db.sales.length, accounts: db.accounts.length, staff: db.users.length,
  }));
  eq(left, { sales: 0, accounts: 0, staff: 0 }, 'records still loaded on a suspended device');
});

await step('no sale slipped through while it was closing', async () => {
  eq(await serverSales(), soldBefore, 'sales on the server');
});

/* ---------- and they cannot get back in ---------- */
await step('they cannot sign back in while suspended', async () => {
  await G.fill('#lg-code', 'AG-01'); await G.fill('#lg-pin', '1111');
  await G.click('#login-form button[type=submit]'); await G.waitForTimeout(5000);
  eq(await G.evaluate(() => $('#app').hidden), true, 'the workspace opened anyway');
  const err = (await G.locator('#login-err').innerText()).trim();
  if (!/suspend/i.test(err)) throw new Error(`sign-in refused with: "${err}"`);
  say(`   "${err}"`);
});

/* ---------- reinstating them works ---------- */
await step('reinstating them lets them straight back to work', async () => {
  await A.locator('[data-action=toggle-user]').first().click();
  await A.waitForTimeout(2500);
  await G.fill('#lg-code', 'AG-01'); await G.fill('#lg-pin', '1111');
  await G.click('#login-form button[type=submit]'); await G.waitForTimeout(6500);
  eq(await G.evaluate(() => $('#app').hidden), false, 'the till did not reopen');

  await G.click('.tab[data-tab=terminal]'); await G.waitForTimeout(800);
  await G.click('.pkg[data-vtype=V5]');
  await G.fill('#c-name', 'Kofi Mensah');
  await G.click('#btn-complete'); await G.waitForTimeout(3500);
  eq(await serverSales(), soldBefore + 1, 'sales on the server');
});

await b.close();
say(failures === 0 ? '\nsuspension suite passed' : `\nsuspension suite: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

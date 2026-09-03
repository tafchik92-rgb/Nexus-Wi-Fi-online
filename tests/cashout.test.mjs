/* ============================================================
   Cash reconciliation — the hand-over ledger.

   The month-end statement always said what an agent collected. It never
   said how much of it had actually been handed in, so the shop could
   read a clean set of reports and still not know whether an agent was
   holding $20 or $2,000. Closing the month did not help: closing freezes
   the takings, it does not collect them.

   What is checked here is the accounting, not the buttons:

     · a hand-over is tagged with the month it covers, and a partial one
       leaves the right balance behind
     · closing a month does not clear what is still owed for it
     · last month's shortfall follows the agent into this one, and can be
       paid off from there — the case the whole feature exists for
     · handing over more than a month is short is refused, because a
       negative balance is a counting error nothing can explain
     · an administrator sees the position across agents and months, and
       voiding a mistaken entry puts the balance back

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     npx serve -l 4199 .
     node tests/cashout.test.mjs
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
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const S = (v) => ({ stringValue: String(v) });
const N = (v) => ({ integerValue: String(v) });

const now = new Date();
const thisPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
const lastPeriod = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
const lastMonthDay = new Date(prev.getFullYear(), prev.getMonth(), 15).toISOString();

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

// What the agent's own screen says the position is.
const position = (page, period) => page.evaluate((p) => {
  const u = currentUser();
  return cashPosition(u.id, p, terminalSiteId());
}, period);

/* ---------- the shop ---------- */
const A = await open('admin');
await A.click('[data-action=show-setup]'); await A.waitForTimeout(300);
await A.fill('#st-name', 'Ada Mensah'); await A.fill('#st-code', 'ADM-01');
await A.fill('#st-pin', '1234'); await A.fill('#st-site', 'Gloy Mine Camp');
await A.click('#setup-form button[type=submit]');
await A.waitForSelector('#app:not([hidden])', { timeout: 40000 });
await A.waitForTimeout(1500);
const siteId = await A.evaluate(() => db.sites[0].id);

await A.click('.subtab[data-sub=team]'); await A.waitForTimeout(700);
await A.fill('#u-name', 'Kira Vance'); await A.fill('#u-code', 'AG-01');
await A.selectOption('#u-role', 'agent'); await A.fill('#u-pin', '1111'); await A.waitForTimeout(400);
await A.check(`#u-sites input[value="${siteId}"]`);
await A.click('#user-form button[type=submit]');
// Waited for rather than slept through. Reading this too early seeded nine
// sales against the literal string "undefined", and every later assertion
// then failed for a reason that had nothing to do with what was being tested.
await A.waitForFunction(() => !!(db.users.find((u) => u.code === 'AG-01') || {}).id, null, { timeout: 30000 });
const agentId = await A.evaluate(() => db.users.find((u) => u.code === 'AG-01').id);
if (!agentId) throw new Error('the agent was never created — nothing below would mean anything');

// Last month: the agent took $90 in cash sales and handed none of it in.
for (let i = 0; i < 9; i++) {
  await fetch(`${REST}/vouchers?documentId=vOld${i}`, { method: 'POST', headers: OWNER, body: JSON.stringify({ fields: {
    code: S(`W10-OLD-${i}`), type: S('V10'), siteId: S(siteId), status: S('sold'), uploadedAt: S(lastMonthDay) } }) });
  await fetch(`${REST}/sales?documentId=sOld${i}`, { method: 'POST', headers: OWNER, body: JSON.stringify({ fields: {
    customer: S('Walk-in'), voucherId: S(`vOld${i}`), voucherCode: S(`W10-OLD-${i}`),
    type: S('V10'), price: N(10), pay: S('cash'),
    agentId: S(agentId), agentName: S('Kira Vance'), siteId: S(siteId), soldAt: S(lastMonthDay) } }) });
}
say(`seeded $90 of cash sales in ${lastPeriod}, none handed in\n`);

/* ---------- the agent ---------- */
const G = await open('agent');
await G.fill('#lg-code', 'AG-01'); await G.fill('#lg-pin', '1111');
await G.click('#login-form button[type=submit]');
await G.waitForSelector('#app:not([hidden])', { timeout: 40000 });
await G.waitForTimeout(2000);
await G.click('.tab[data-tab=monthend]'); await G.waitForTimeout(800);
await G.fill('#me-period', lastPeriod); await G.waitForTimeout(1500);

await step('the month-end screen shows the cash that has not been handed in', async () => {
  eq(await position(G, lastPeriod), { period: lastPeriod, userId: agentId, siteId,
    due: 90, handedOver: 0, outstanding: 90, closed: false }, 'position');
  const chip = (await G.locator('#co-status').innerText()).trim();
  if (!/90/.test(chip)) throw new Error(`status chip reads "${chip}"`);
  say(`   ${chip}`);
});

/* ---------- a partial hand-over, tagged to that month ---------- */
await step('a partial hand-over leaves the right balance behind', async () => {
  await G.click('#btn-cashout'); await G.waitForTimeout(600);
  eq(await G.evaluate(() => $('#cashout-period').value), lastPeriod, 'month the modal defaulted to');
  await G.fill('#cashout-amount', '50');
  await G.fill('#cashout-ref', 'slip 001');
  await G.click('#cashout-confirm'); await G.waitForTimeout(3000);

  const pos = await position(G, lastPeriod);
  eq([pos.due, pos.handedOver, pos.outstanding], [90, 50, 40], 'due / handed over / outstanding');
});

await step('over-handing is refused — a negative balance explains nothing', async () => {
  await G.click('#btn-cashout'); await G.waitForTimeout(600);
  await G.fill('#cashout-amount', '500');
  await G.click('#cashout-confirm'); await G.waitForTimeout(1200);
  const err = (await G.locator('#cashout-err').innerText()).trim();
  if (!/more than/i.test(err)) throw new Error(`error shown: "${err}"`);
  eq((await position(G, lastPeriod)).outstanding, 40, 'outstanding after the refusal');
  say(`   "${err}"`);
  await G.click('#cashout-cancel'); await G.waitForTimeout(400);
});

/* ---------- closing the month must not clear the debt ---------- */
await step('closing the month does not collect the money', async () => {
  await G.click('#btn-close-month'); await G.waitForTimeout(700);
  await G.click('#confirm-yes'); await G.waitForTimeout(3500);
  const pos = await position(G, lastPeriod);
  eq([pos.closed, pos.due, pos.outstanding], [true, 90, 40], 'closed / due / outstanding');
});

/* ---------- and it follows them into the new month ---------- */
await step('last month\'s shortfall is brought forward into this one', async () => {
  await G.fill('#me-period', thisPeriod); await G.waitForTimeout(1800);
  const brought = (await G.locator('#co-brought').innerText()).replace(/\n+/g, ' | ');
  if (!/BROUGHT FORWARD/i.test(brought)) throw new Error(`no brought-forward section: ${brought}`);
  if (!/\$40/.test(brought)) throw new Error(`brought forward reads: ${brought}`);
  say(`   ${brought.split('BROUGHT FORWARD')[1].slice(0, 120).trim()}`);
});

await step('and it can be paid off from the new month, still tagged to the old one', async () => {
  await G.click('#btn-cashout'); await G.waitForTimeout(600);
  // The oldest month still owing is what the modal offers first — paying
  // against this month while an older one is short is how a shortfall hides.
  eq(await G.evaluate(() => $('#cashout-period').value), lastPeriod, 'month the modal defaulted to');
  await G.click('#cashout-all'); await G.waitForTimeout(300);
  eq(await G.evaluate(() => $('#cashout-amount').value), '40', 'the "hand over all" amount');
  await G.click('#cashout-confirm'); await G.waitForTimeout(3000);

  const pos = await position(G, lastPeriod);
  eq([pos.due, pos.handedOver, pos.outstanding], [90, 90, 0], 'last month, after settling');
  const brought = (await G.locator('#co-brought').innerText());
  if (/BROUGHT FORWARD/i.test(brought)) throw new Error('still showing a brought-forward balance');
});

/* ---------- the administrator's audit view ---------- */
await A.click('.subtab[data-sub=cash]'); await A.waitForTimeout(1500);

await step('the administrator can audit every hand-over', async () => {
  const ledger = (await A.locator('#cash-ledger-tbody').innerText()).replace(/\n+/g, ' | ');
  if (!/slip 001/.test(ledger)) throw new Error(`reference missing from the ledger: ${ledger}`);
  const rows = await A.locator('#cash-ledger-tbody tr').count();
  eq(rows, 2, 'ledger rows');
  say(`   ${ledger.slice(0, 150)}`);
});

await step('and see the position per agent, per month', async () => {
  const pos = (await A.locator('#cash-position-tbody').innerText()).replace(/\n+/g, ' | ');
  if (!/Kira Vance/.test(pos)) throw new Error(`agent missing: ${pos}`);
  const tiles = (await A.locator('#cash-tiles').innerText()).replace(/\n+/g, ' ');
  if (!/STILL WITH AGENTS \$0/.test(tiles)) throw new Error(`tiles read: ${tiles}`);
  say(`   ${tiles}`);
});

/* ---------- voiding a mistake puts the balance back ---------- */
await step('voiding a mistaken hand-over makes the month owe again', async () => {
  await A.locator('[data-action=void-cashout]').first().click(); await A.waitForTimeout(700);
  await A.fill('#voidcash-reason', 'counted twice at the desk');
  await A.click('#voidcash-confirm'); await A.waitForTimeout(3000);

  const owed = await A.evaluate(([u, p, s]) => cashPosition(u, p, s), [agentId, lastPeriod, siteId]);
  if (owed.outstanding <= 0) throw new Error(`still settled: ${JSON.stringify(owed)}`);
  say(`   ${lastPeriod} owes ${owed.outstanding} again (was 0)`);
});

await step('the voided entry stays on the record, with the reason', async () => {
  const ledger = (await A.locator('#cash-ledger-tbody').innerText());
  if (!/counted twice at the desk/.test(ledger)) throw new Error('the reason is not on the ledger');
  const struck = await A.locator('#cash-ledger-tbody tr.row-reversed').count();
  eq(struck, 1, 'rows struck through');
});

await step('the agent sees it come back as owing, without reloading', async () => {
  await G.waitForTimeout(2500);
  const pos = await position(G, lastPeriod);
  if (pos.outstanding <= 0) throw new Error(`agent still shows settled: ${JSON.stringify(pos)}`);
  const brought = (await G.locator('#co-brought').innerText());
  if (!/BROUGHT FORWARD/i.test(brought)) throw new Error('the agent is not being told it is owing again');
  say(`   agent now owes ${pos.outstanding} for ${lastPeriod}`);
});

await b.close();
say(failures === 0 ? '\ncash-out suite passed' : `\ncash-out suite: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

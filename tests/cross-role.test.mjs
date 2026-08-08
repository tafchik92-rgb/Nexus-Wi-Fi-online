/* ============================================================
   Does an administrator's reversal reach the agent's screens?

   Both are signed in at once, in separate browsers, as they would be in
   the shop — the admin at the back, the agent on the till. Nobody
   refreshes anything. What has to follow the reversal, live:
     · the agent's MY DAY tally
     · the restocked code, back in the terminal
     · the customer's debt on the agent's CREDIT tab
     · the agent's month-end totals

   And the one thing that must NOT move: a month the agent has already
   closed is frozen, by design. The reversal dialog warns about it.

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     npx serve -l 4199 .
     node tests/cross-role.test.mjs
   ============================================================ */

import fs from 'node:fs'; import path from 'node:path';

// Playwright is not a dependency of the app; this suite is opt-in.
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch (_) { /* try the next */ }
}
if (!chromium) {
  console.log('Playwright not installed — skipping the cross-role suite.');
  process.exit(0);
}
const PROJECT = 'nexus-pos-fn-test';
const SDK_DIR = process.env.NEXUS_SDK_MIRROR || '';
const ORIGIN = process.env.NEXUS_ORIGIN || 'http://127.0.0.1:4199';
await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const step = async (n, f) => { try { await f(); console.log('PASS  ' + n); } catch (e) { console.log('FAIL  ' + n + ' → ' + String(e.message).split('\n')[0]); process.exitCode = 1; } };

const open = async (label) => {
  const ctx = await b.newContext({ serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log(`   [${label}] PAGEERROR: ` + e.message));
  if (SDK_DIR && fs.existsSync(SDK_DIR)) {
    await p.route(/gstatic\.com\/firebasejs\//, (r) => {
      const f = path.join(SDK_DIR, r.request().url().split('/').pop());
      if (!fs.existsSync(f)) return r.abort();
      r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
    });
  }
  await p.route('**/firebase-config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: `window.NEXUS_FIREBASE_CONFIG = ${JSON.stringify({ apiKey:'fake-api-key', authDomain:`${PROJECT}.firebaseapp.com`, projectId:PROJECT, useEmulators:true, emulatorHost:'127.0.0.1' })};` }));
  await p.goto(`${ORIGIN}/index.html`); await p.waitForTimeout(3200);
  return { ctx, p };
};

// ---- admin sets up the shop ----
const A = await open('admin');
await A.p.click('[data-action=show-setup]'); await A.p.waitForTimeout(300);
await A.p.fill('#st-name','Ada Mensah'); await A.p.fill('#st-code','ADM-01');
await A.p.fill('#st-pin','1234'); await A.p.fill('#st-site','Gloy Mine Camp');
await A.p.click('#setup-form button[type=submit]'); await A.p.waitForTimeout(5000);
const siteId = await A.p.evaluate(() => db.sites[0].id);
await A.p.click('.subtab[data-sub=vouchers]'); await A.p.waitForTimeout(700);
await A.p.fill('#up-codes', ['W5-A','W5-B','W5-C'].join('\n'));
await A.p.click('#voucher-form button[type=submit]'); await A.p.waitForTimeout(2500);
await A.p.click('#up-type .seg-btn[data-vtype=V10]');
await A.p.fill('#up-codes', 'W10-A');
await A.p.click('#voucher-form button[type=submit]'); await A.p.waitForTimeout(2500);
await A.p.click('.subtab[data-sub=team]'); await A.p.waitForTimeout(700);
await A.p.fill('#u-name','Kira Vance'); await A.p.fill('#u-code','AG-01');
await A.p.selectOption('#u-role','agent'); await A.p.fill('#u-pin','1111'); await A.p.waitForTimeout(400);
await A.p.check(`#u-sites input[value="${siteId}"]`);
await A.p.click('#user-form button[type=submit]'); await A.p.waitForTimeout(3000);

// ---- the agent signs in on their own device and sells ----
const G = await open('agent');
await G.p.fill('#lg-code','AG-01'); await G.p.fill('#lg-pin','1111');
await G.p.click('#login-form button[type=submit]'); await G.p.waitForTimeout(6000);

await step('the agent sells a cash sale and a credit sale', async () => {
  await G.p.click('.tab[data-tab=terminal]'); await G.p.waitForTimeout(800);
  await G.p.click('.pkg[data-vtype=V5]');
  await G.p.fill('#c-name', 'Amina Diallo');
  await G.p.click('#btn-complete'); await G.p.waitForTimeout(3500);
  await G.p.click('#btn-new-sale');
  await G.p.click('.pkg[data-vtype=V10]');
  await G.p.fill('#c-name', 'Joel Okafor');
  await G.p.click('#pay-seg .seg-btn[data-pay=credit]');
  await G.p.click('#btn-complete'); await G.p.waitForTimeout(3500);
  await G.p.click('#btn-new-sale');
  await G.p.waitForTimeout(1500);
});

const beforeAgent = await G.p.evaluate(() => ({
  dayCash: document.getElementById('log-summary').innerText,
  owed: totalOutstanding(''),
  stock: db.vouchers.filter(v => v.status === 'available').length,
  logRows: document.querySelectorAll('#agent-log li').length,
}));
console.log('   agent before →', JSON.stringify({ owed: beforeAgent.owed, stock: beforeAgent.stock, logRows: beforeAgent.logRows }));

// ---- admin reverses the agent's CASH sale, with the agent still signed in ----
await step("the admin reverses the agent's cash sale", async () => {
  await A.p.click('.tab[data-tab=admin]'); await A.p.click('.subtab[data-sub=dash]'); await A.p.waitForTimeout(1200);
  const row = A.p.locator('#sales-tbody tr').filter({ hasText: 'Amina Diallo' }).first();
  await row.locator('[data-action=reverse-sale]').click(); await A.p.waitForTimeout(700);
  await A.p.fill('#rev-reason', 'double-billed after a network drop');
  await A.p.click('#rev-confirm'); await A.p.waitForTimeout(4000);
});

// ---- what does the agent see now, without touching anything? ----
await G.p.waitForTimeout(3000);

await step("the agent's own day tally drops the reversed sale, live", async () => {
  const after = await G.p.evaluate(() => ({
    summary: document.getElementById('log-summary').innerText,
    logRows: document.querySelectorAll('#agent-log li').length,
    reversalsSeen: db.reversals.length,
  }));
  if (after.reversalsSeen !== 1) throw new Error('agent synced ' + after.reversalsSeen + ' reversals');
  if (after.logRows !== beforeAgent.logRows - 1) {
    throw new Error(`MY DAY still lists ${after.logRows} sales (was ${beforeAgent.logRows})`);
  }
  if (!/CASH SALES\s*\$0/.test(after.summary.replace(/\n/g, ' '))) {
    throw new Error('cash still counted: ' + after.summary.replace(/\n/g, ' '));
  }
  console.log('   agent MY DAY →', after.summary.replace(/\n/g, ' | '));
});

await step('the restocked voucher reappears in the agent terminal', async () => {
  const stock = await G.p.evaluate(() => db.vouchers.filter(v => v.status === 'available').length);
  if (stock !== beforeAgent.stock + 1) throw new Error(`stock ${beforeAgent.stock} → ${stock}`);
  // the $5 group specifically: 3 loaded, 1 sold, then that sale reversed
  const cards = await G.p.locator('#pkg-cards').innerText();
  if (!/STOCK 3/.test(cards)) throw new Error('terminal shows: ' + cards.replace(/\n/g, ' '));
});

// ---- now reverse the CREDIT sale and check the agent's credit view ----
await step("the admin reverses the agent's credit sale", async () => {
  await A.p.waitForTimeout(1000);
  const row = A.p.locator('#sales-tbody tr').filter({ hasText: 'Joel Okafor' }).first();
  await row.locator('[data-action=reverse-sale]').click(); await A.p.waitForTimeout(700);
  await A.p.fill('#rev-reason', 'billed in error');
  await A.p.click('#rev-confirm'); await A.p.waitForTimeout(4000);
});

await G.p.waitForTimeout(3000);

await step("the customer's debt clears on the agent's CREDIT tab", async () => {
  await G.p.click('.tab[data-tab=credit]'); await G.p.waitForTimeout(1200);
  const owed = await G.p.evaluate(() => totalOutstanding(''));
  if (owed !== 0) throw new Error(`agent still shows $${owed} outstanding (was $${beforeAgent.owed})`);
  const txt = await G.p.locator('#ag-credit-tiles').innerText();
  if (!/\$0/.test(txt)) throw new Error('credit tiles: ' + txt.replace(/\n/g, ' '));
});

await step("the agent's month-end totals exclude both reversed sales", async () => {
  await G.p.click('.tab[data-tab=monthend]'); await G.p.waitForTimeout(1200);
  const r = await G.p.evaluate(() => {
    const u = currentUser();
    return buildReport(u.id, document.getElementById('me-period').value, currentSiteId());
  });
  if (r.salesCount !== 0) throw new Error(r.salesCount + ' sales still counted in month-end');
  if (r.cashSalesTotal !== 0) throw new Error('cash total ' + r.cashSalesTotal);
  if (r.creditIssued !== 0) throw new Error('credit issued ' + r.creditIssued);
  const shown = await G.p.locator('#me-tiles').innerText();
  console.log('   agent month-end →', shown.replace(/\n/g, ' | ').slice(0, 110));
});

// The one place a reversal deliberately does NOT move the agent's numbers:
// a month they have already closed is frozen by design.
await step('a month the agent already closed stays frozen', async () => {
  // sell one more, close the month, then have the admin reverse it
  await G.p.click('.tab[data-tab=terminal]'); await G.p.waitForTimeout(900);
  await G.p.click('#pay-seg .seg-btn[data-pay=cash]');   // still on CREDIT from earlier
  await G.p.click('.pkg[data-vtype=V5]');
  await G.p.fill('#c-name', 'Rita Mensah');
  await G.p.click('#btn-complete'); await G.p.waitForTimeout(3500);
  await G.p.click('#btn-new-sale');

  await G.p.click('.tab[data-tab=monthend]'); await G.p.waitForTimeout(1200);
  await G.p.click('#btn-close-month'); await G.p.waitForTimeout(700);
  await G.p.click('#confirm-yes'); await G.p.waitForTimeout(3500);
  const closedTotal = await G.p.evaluate(() => {
    const u = currentUser();
    const c = closingFor(u.id, document.getElementById('me-period').value, currentSiteId());
    return c ? c.totals.totalCashCollected : null;
  });
  if (closedTotal !== 5) throw new Error('closed with ' + closedTotal + ', expected 5');

  await A.p.waitForTimeout(1200);
  await A.p.click('.subtab[data-sub=dash]'); await A.p.waitForTimeout(1000);
  const row = A.p.locator('#sales-tbody tr').filter({ hasText: 'Rita Mensah' }).first();
  await row.locator('[data-action=reverse-sale]').click(); await A.p.waitForTimeout(800);
  const notes = await A.p.locator('#rev-notes').innerText();
  if (!/closed/i.test(notes)) throw new Error('no warning that the month is closed: ' + notes);
  await A.p.fill('#rev-reason', 'reversed after close');
  await A.p.click('#rev-confirm'); await A.p.waitForTimeout(4000);

  await G.p.waitForTimeout(3000);
  const after = await G.p.evaluate(() => {
    const u = currentUser();
    const period = document.getElementById('me-period').value;
    const c = closingFor(u.id, period, currentSiteId());
    return { frozen: c ? c.totals.totalCashCollected : null,
             live: buildReport(u.id, period, currentSiteId()).totalCashCollected };
  });
  if (after.frozen !== 5) throw new Error('the closed figure moved: ' + after.frozen);
  if (after.live !== 0) throw new Error('live figure did not drop: ' + after.live);
  console.log(`   closed month still reads $${after.frozen}; live now $${after.live}`);
});

await b.close();
console.log(process.exitCode === 1 ? '\ncross-role suite FAILED' : '\ncross-role suite passed');

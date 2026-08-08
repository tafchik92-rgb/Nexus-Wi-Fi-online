/* ============================================================
   An agent closes a month still owed money, then recovers it later.

   The rule the shop runs on: debt is recognised when the credit is
   issued, cash when it is collected. So a month closed owed $80 keeps
   that $80 as its outstanding figure for ever — that is what was true
   when it closed — and the $80 appears as collected in whichever month
   the customer actually paid. It is never counted in both.

   Also guards the administrator's view of it. An agent closes under
   their own site, so an administrator on ALL SITES once saw every agent
   as OPEN for ever — on the exact screen used to check who has closed
   and handed their cash over.

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     npx serve -l 4199 .
     node tests/carryover.test.mjs
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

await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const say = console.log;

const open = async () => {
  const ctx = await b.newContext({ serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => say('   PAGEERROR: ' + e.message));
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
  return p;
};

const A = await open();
await A.click('[data-action=show-setup]'); await A.waitForTimeout(300);
await A.fill('#st-name','Ada Mensah'); await A.fill('#st-code','ADM-01');
await A.fill('#st-pin','1234'); await A.fill('#st-site','Gloy Mine Camp');
await A.click('#setup-form button[type=submit]'); await A.waitForTimeout(5000);
const siteId = await A.evaluate(() => db.sites[0].id);
await A.click('.subtab[data-sub=team]'); await A.waitForTimeout(700);
await A.fill('#u-name','Kira Vance'); await A.fill('#u-code','AG-01');
await A.selectOption('#u-role','agent'); await A.fill('#u-pin','1111'); await A.waitForTimeout(400);
await A.check(`#u-sites input[value="${siteId}"]`);
await A.click('#user-form button[type=submit]'); await A.waitForTimeout(3000);
const agentId = await A.evaluate(() => (db.users.find(u => u.code === 'AG-01') || {}).id);

// last month: the agent issued $80 on credit to one customer
const lastMonthDay = new Date(prev.getFullYear(), prev.getMonth(), 15).toISOString();
await fetch(`${REST}/accounts?documentId=accJoel`, { method: 'POST', headers: OWNER, body: JSON.stringify({ fields: {
  name: S('Joel Okafor'), phone: S('+233 20 111 2222'), siteId: S(siteId), createdAt: S(lastMonthDay) } }) });
for (let i = 0; i < 8; i++) {
  await fetch(`${REST}/vouchers?documentId=vOld${i}`, { method: 'POST', headers: OWNER, body: JSON.stringify({ fields: {
    code: S(`W10-OLD-${i}`), type: S('V10'), siteId: S(siteId), status: S('sold'), uploadedAt: S(lastMonthDay) } }) });
  await fetch(`${REST}/sales?documentId=sOld${i}`, { method: 'POST', headers: OWNER, body: JSON.stringify({ fields: {
    customer: S('Joel Okafor'), phone: S('+233 20 111 2222'), accountId: S('accJoel'),
    voucherId: S(`vOld${i}`), voucherCode: S(`W10-OLD-${i}`), type: S('V10'), price: N(10),
    pay: S('credit'), agentId: S(agentId), agentName: S('Kira Vance'),
    siteId: S(siteId), soldAt: S(lastMonthDay) } }) });
}
say(`seeded 8 credit sales of $10 in ${lastPeriod}, all unpaid\n`);

// ---- the agent closes last month ----
const G = await open();
await G.fill('#lg-code','AG-01'); await G.fill('#lg-pin','1111');
await G.click('#login-form button[type=submit]'); await G.waitForTimeout(6500);
await G.click('.tab[data-tab=monthend]'); await G.waitForTimeout(1000);
await G.fill('#me-period', lastPeriod); await G.waitForTimeout(1200);
say(`${lastPeriod} before closing (agent):`);
say('   ' + (await G.locator('#me-tiles').innerText()).replace(/\n+/g, ' | '));
await G.click('#btn-close-month'); await G.waitForTimeout(700);
await G.click('#confirm-yes'); await G.waitForTimeout(3500);
say(`   → closed\n`);

// ---- this month: the customer pays the $80 ----
await G.click('.tab[data-tab=credit]'); await G.waitForTimeout(1200);
await G.locator('[data-action=settle]').first().click(); await G.waitForTimeout(700);
await G.click('#settle-full'); await G.waitForTimeout(300);
await G.click('#settle-confirm'); await G.waitForTimeout(3500);
await G.click('#receipt-done').catch(() => {});
say(`the customer paid the $80 in ${thisPeriod}\n`);
await G.waitForTimeout(1500);

// ---- where does it show? ----
say('AGENT, last month (closed, frozen):');
await G.click('.tab[data-tab=monthend]'); await G.waitForTimeout(800);
await G.fill('#me-period', lastPeriod); await G.waitForTimeout(1500);
say('   ' + (await G.locator('#me-tiles').innerText()).replace(/\n+/g, ' | '));
say('   status: ' + (await G.locator('#me-status').innerText()).trim());

say('\nAGENT, this month:');
await G.fill('#me-period', thisPeriod); await G.waitForTimeout(1500);
say('   ' + (await G.locator('#me-tiles').innerText()).replace(/\n+/g, ' | '));

say('\nthe numbers behind those views:');
say('   ' + JSON.stringify(await G.evaluate(([lp, tp]) => {
  const u = currentUser(); const site = currentSiteId();
  const closed = closingFor(u.id, lp, site);
  return {
    lastMonth_frozen_unpaid: closed ? closed.totals.unpaidFromPeriod : null,
    lastMonth_frozen_collected: closed ? closed.totals.totalCashCollected : null,
    lastMonth_liveRecompute_unpaid: buildReport(u.id, lp, site).unpaidFromPeriod,
    thisMonth_debtCollected: buildReport(u.id, tp, site).debtCollected,
    thisMonth_totalCash: buildReport(u.id, tp, site).totalCashCollected,
    owedNow: totalOutstanding(site),
  };
}, [lastPeriod, thisPeriod])));

say('\nADMIN, last month (report recomputed live):');
await A.click('.tab[data-tab=admin]'); await A.click('.subtab[data-sub=reports]'); await A.waitForTimeout(900);
await A.fill('#rep-period', lastPeriod); await A.waitForTimeout(1500);
say('   ' + (await A.locator('#rep-tbody').innerText()).replace(/\n+/g, ' | '));
say('   tiles: ' + (await A.locator('#rep-tiles').innerText()).replace(/\n+/g, ' | '));

// ---- the properties this all has to satisfy ----
let bad = 0;
const must = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : ' → ' + detail));
  if (!cond) bad++;
};
const n = await G.evaluate(([lp, tp]) => {
  const u = currentUser(); const site = currentSiteId();
  const closed = closingFor(u.id, lp, site);
  return {
    frozenUnpaid: closed ? closed.totals.unpaidFromPeriod : null,
    frozenCollected: closed ? closed.totals.totalCashCollected : null,
    lastLiveUnpaid: buildReport(u.id, lp, site).unpaidFromPeriod,
    thisCollected: buildReport(u.id, tp, site).debtCollected,
    thisTotalCash: buildReport(u.id, tp, site).totalCashCollected,
    lastTotalCash: buildReport(u.id, lp, site).totalCashCollected,
    owedNow: totalOutstanding(site),
  };
}, [lastPeriod, thisPeriod]);

console.log('');
must('the closed month keeps the $80 it was owed when it closed',
  n.frozenUnpaid === 80, `frozen unpaid is ${n.frozenUnpaid}`);
must('the closed month still shows $0 cash — none had been collected then',
  n.frozenCollected === 0, `frozen cash is ${n.frozenCollected}`);
must('the recovery lands in the month it was received, not the month sold',
  n.thisCollected === 80 && n.thisTotalCash === 80,
  `this month collected ${n.thisCollected}, total cash ${n.thisTotalCash}`);
must('the $80 is not counted twice across the two months',
  n.lastTotalCash + n.thisTotalCash === 80,
  `${n.lastTotalCash} + ${n.thisTotalCash}`);
must('nothing is outstanding once it is paid', n.owedNow === 0, `owed ${n.owedNow}`);
must('re-reading the old month live shows the debt cleared',
  n.lastLiveUnpaid === 0, `live unpaid ${n.lastLiveUnpaid}`);

const adminRow = await A.locator('#rep-tbody').innerText();
must('the administrator sees the month as CLOSED on ALL SITES',
  /CLOSED/.test(adminRow), `row reads: ${adminRow.replace(/\n/g, ' ')}`);

await b.close();
console.log(bad ? '\ncarry-over suite FAILED' : '\ncarry-over suite passed');
process.exit(bad ? 1 : 0);

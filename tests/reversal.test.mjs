/* ============================================================
   Reversing a sale.

   Written for a real incident: a network wobble billed one customer for
   two vouchers. What has to hold afterwards —
     · the duplicate comes off the takings
     · its code goes back into stock, or out of use if the customer
       already has it
     · the sale itself stays in the ledger, marked, with a reason
     · one sale can be reversed exactly once, enforced by the database
     · money already collected is reported before anything is undone

   Usage:
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     npx serve -l 4199 .
     node tests/reversal.test.mjs
   ============================================================ */

import fs from 'node:fs'; import path from 'node:path';

// Playwright is not a dependency of the app; this suite is opt-in.
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch (_) { /* try the next */ }
}
if (!chromium) {
  console.log('Playwright not installed — skipping the reversal suite.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}
const PROJECT = 'nexus-pos-fn-test';
// Offline mirror of the Firebase SDK, used only where gstatic is unreachable.
const SDK_DIR = process.env.NEXUS_SDK_MIRROR || '';
const ORIGIN = process.env.NEXUS_ORIGIN || 'http://127.0.0.1:4199';
await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const step = async (n, f) => { try { await f(); console.log('PASS  ' + n); } catch (e) { console.log('FAIL  ' + n + ' → ' + String(e.message).split('\n')[0]); process.exitCode = 1; } };
const ctx = await b.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('   PAGEERROR: ' + e.message));
if (SDK_DIR && fs.existsSync(SDK_DIR)) {
  await p.route(/gstatic\.com\/firebasejs\//, (r) => {
    const f = path.join(SDK_DIR, r.request().url().split('/').pop());
    if (!fs.existsSync(f)) return r.abort();
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
  });
}
await p.route('**/firebase-config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
  body: `window.NEXUS_FIREBASE_CONFIG = ${JSON.stringify({ apiKey:'fake-api-key', authDomain:`${PROJECT}.firebaseapp.com`, projectId:PROJECT, useEmulators:true, emulatorHost:'127.0.0.1' })};` }));
await p.goto(`${ORIGIN}/index.html`); await p.waitForTimeout(3500);
await p.click('[data-action=show-setup]'); await p.waitForTimeout(300);
await p.fill('#st-name','Ada Mensah'); await p.fill('#st-code','ADM-01');
await p.fill('#st-pin','1234'); await p.fill('#st-site','Gloy Mine Camp');
await p.click('#setup-form button[type=submit]'); await p.waitForTimeout(5000);
await p.click('.subtab[data-sub=vouchers]'); await p.waitForTimeout(700);
await p.fill('#up-codes', ['W5-A','W5-B','W5-C','W5-D'].join('\n'));
await p.click('#voucher-form button[type=submit]'); await p.waitForTimeout(2500);

// the incident: the same customer billed twice
let codes = [];
await step('the customer is billed twice, as happened', async () => {
  await p.click('.tab[data-tab=terminal]'); await p.waitForTimeout(700);
  for (let i = 0; i < 2; i++) {
    await p.click('.pkg[data-vtype=V5]');
    await p.fill('#c-name', 'Amina Diallo');
    await p.click('#btn-complete'); await p.waitForTimeout(3500);
    codes.push(await p.locator('#sale-code').innerText());
    await p.click('#btn-new-sale'); await p.waitForTimeout(400);
  }
  if (codes.length !== 2 || codes[0] === codes[1]) throw new Error('codes: ' + codes.join(','));
  const st = await p.evaluate(() => ({ sales: db.sales.length, stock: db.vouchers.filter(v => v.status === 'available').length }));
  if (st.sales !== 2 || st.stock !== 2) throw new Error(JSON.stringify(st));
});

const before = await p.evaluate(() => ({
  takings: liveSales('').reduce((n, s) => n + s.price, 0),
  stock: db.vouchers.filter(v => v.status === 'available').length,
}));

await step('the duplicate can be reversed, with a reason on the record', async () => {
  await p.click('.tab[data-tab=admin]'); await p.click('.subtab[data-sub=dash]'); await p.waitForTimeout(1000);
  const btns = p.locator('[data-action=reverse-sale]');
  if (await btns.count() !== 2) throw new Error(await btns.count() + ' reverse buttons for 2 sales');
  await btns.first().click(); await p.waitForTimeout(700);
  if (await p.locator('#modal-reverse').isHidden()) throw new Error('no reversal dialog');
  await p.click('#rev-confirm'); await p.waitForTimeout(600);
  const refused = await p.locator('#toasts').innerText();
  if (!/Say why/i.test(refused)) throw new Error('accepted a reversal with no reason: ' + refused);
  await p.fill('#rev-reason', 'double-billed after a network drop');
  await p.click('#rev-confirm'); await p.waitForTimeout(4000);
  if (!(await p.locator('#modal-reverse').isHidden())) throw new Error('dialog stayed open');
});

await step('the voucher went back into stock', async () => {
  const after = await p.evaluate(() => db.vouchers.filter(v => v.status === 'available').length);
  if (after !== before.stock + 1) throw new Error(`stock ${before.stock} → ${after}`);
});

await step('the takings dropped by exactly that sale', async () => {
  const after = await p.evaluate(() => liveSales('').reduce((n, s) => n + s.price, 0));
  if (after !== before.takings - 5) throw new Error(`takings ${before.takings} → ${after}`);
});

await step('the sale is still in the ledger, marked reversed', async () => {
  const row = await p.locator('#sales-tbody tr.row-reversed').count();
  if (row !== 1) throw new Error(row + ' reversed rows');
  const txt = await p.locator('#sales-tbody').innerText();
  if (!/REVERSED/.test(txt)) throw new Error('no REVERSED marker');
  if (!/double-billed/.test(txt)) throw new Error('the reason is not shown');
  const sales = await p.evaluate(() => db.sales.length);
  if (sales !== 2) throw new Error('the sale was deleted rather than reversed: ' + sales);
});

await step('the same sale cannot be reversed twice', async () => {
  const left = await p.locator('[data-action=reverse-sale]').count();
  if (left !== 1) throw new Error(left + ' reverse buttons left, expected 1');
  // and the database itself refuses a second, not just the button being gone
  const dup = await p.evaluate(async () => {
    const s = db.sales.find(x => db.reversals.some(r => r.saleId === x.id));
    try { await Backend.reverseSale(s, { outcome: 'voided', reason: 'again' }); return 'ACCEPTED'; }
    catch (e) { return String(e.message); }
  });
  if (dup === 'ACCEPTED') throw new Error('a second reversal of the same sale was accepted');
  if (!/ALREADY_REVERSED|permission|denied/i.test(dup)) throw new Error('refused for the wrong reason: ' + dup);
  const st = await p.evaluate(() => ({
    revs: db.reversals.length,
    stock: db.vouchers.filter(v => v.status === 'available').length,
  }));
  if (st.revs !== 1) throw new Error(st.revs + ' reversal records for one sale');
  if (st.stock !== 3) throw new Error('stock is ' + st.stock + ' — the retry changed it');
  console.log('           second attempt refused: ' + dup.slice(0, 60));
});

await step('voiding takes a code out of circulation instead', async () => {
  await p.reload(); await p.waitForTimeout(5000);
  await p.click('.subtab[data-sub=dash]'); await p.waitForTimeout(900);
  await p.locator('[data-action=reverse-sale]').first().click(); await p.waitForTimeout(700);
  await p.click('#rev-outcome .seg-btn[data-outcome=voided]'); await p.waitForTimeout(300);
  const hint = await p.locator('#rev-outcome-hint').innerText();
  if (!/never be sold again/i.test(hint)) throw new Error('hint: ' + hint);
  await p.fill('#rev-reason', 'customer kept the code');
  await p.click('#rev-confirm'); await p.waitForTimeout(4000);
  const st = await p.evaluate(() => ({
    voided: db.vouchers.filter(v => v.status === 'void').length,
    available: db.vouchers.filter(v => v.status === 'available').length,
  }));
  if (st.voided !== 1) throw new Error('voided ' + st.voided);
  if (st.available !== 3) throw new Error('available ' + st.available + ', a voided code returned to stock');
});

await step('a voided code is never handed out again', async () => {
  await p.click('.tab[data-tab=terminal]'); await p.waitForTimeout(800);
  const sold = [];
  for (let i = 0; i < 3; i++) {
    await p.click('.pkg[data-vtype=V5]');
    await p.fill('#c-name', 'Later Customer ' + i);
    await p.click('#btn-complete'); await p.waitForTimeout(3500);
    if (await p.locator('#modal-sale').isHidden()) break;
    sold.push(await p.locator('#sale-code').innerText());
    await p.click('#btn-new-sale'); await p.waitForTimeout(400);
  }
  const voidCode = await p.evaluate(() => (db.vouchers.find(v => v.status === 'void') || {}).code);
  if (sold.includes(voidCode)) throw new Error(`the voided code ${voidCode} was sold again`);
  if (sold.length !== 3) throw new Error('sold ' + sold.length + ' of the 3 remaining');
});

await step('the reversal reached the server, and the sale is still there', async () => {
  const rd = await (await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/reversals`,
    { headers: { Authorization: 'Bearer owner' } })).json();
  const sd = await (await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/sales`,
    { headers: { Authorization: 'Bearer owner' } })).json();
  const revs = rd.documents || [], sales = sd.documents || [];
  if (revs.length < 2) throw new Error(revs.length + ' reversals on the server');
  if (sales.length !== 5) throw new Error(sales.length + ' sales on the server, expected 5 kept');
  const f = revs[0].fields;
  if (!f.reason || !f.reversedBy || !f.outcome) throw new Error('reversal missing fields: ' + Object.keys(f).join(','));
});



// ---- reversing a credit sale the customer has already part-paid ----
await step('a part-paid credit sale warns before it is reversed', async () => {
  await p.click('.tab[data-tab=admin]'); await p.click('.subtab[data-sub=vouchers]'); await p.waitForTimeout(800);
  await p.fill('#up-codes', 'W10-A');
  await p.click('#up-type .seg-btn[data-vtype=V10]');
  await p.click('#voucher-form button[type=submit]'); await p.waitForTimeout(2500);

  await p.click('.tab[data-tab=terminal]'); await p.waitForTimeout(800);
  await p.click('.pkg[data-vtype=V10]');
  await p.fill('#c-name', 'Joel Okafor');
  await p.click('#pay-seg .seg-btn[data-pay=credit]');
  await p.click('#btn-complete'); await p.waitForTimeout(3500);
  await p.click('#btn-new-sale');

  await p.click('.tab[data-tab=admin]'); await p.click('.subtab[data-sub=credit]'); await p.waitForTimeout(1000);
  await p.locator('[data-action=settle]').first().click(); await p.waitForTimeout(600);
  await p.fill('#settle-amount', '4');
  await p.click('#settle-confirm'); await p.waitForTimeout(3000);
  await p.click('#receipt-done').catch(() => {});

  const owedBefore = await p.evaluate(() => totalOutstanding(''));
  if (owedBefore !== 6) throw new Error('owed ' + owedBefore + ' after paying 4 of 10');

  await p.click('.subtab[data-sub=dash]'); await p.waitForTimeout(900);
  const row = p.locator('#sales-tbody tr').filter({ hasText: 'Joel Okafor' }).first();
  await row.locator('[data-action=reverse-sale]').click(); await p.waitForTimeout(700);
  const notes = await p.locator('#rev-notes').innerText();
  if (!/\$4/.test(notes) || !/collected/i.test(notes)) throw new Error('no warning about money taken: ' + notes);
});

await step('reversing it clears the debt and leaves the payment on record', async () => {
  await p.fill('#rev-reason', 'billed in error');
  await p.click('#rev-confirm'); await p.waitForTimeout(4000);
  const after = await p.evaluate(() => ({
    owed: totalOutstanding(''),
    payments: db.payments.length,
    paidNoted: (db.reversals.find(r => r.customer === 'Joel Okafor') || {}).paidAtReversal,
  }));
  if (after.owed !== 0) throw new Error('still owes ' + after.owed);
  if (after.payments !== 1) throw new Error('the settlement was deleted: ' + after.payments);
  if (after.paidNoted !== 4) throw new Error('the reversal did not record the $4 taken: ' + after.paidNoted);
});

await b.close();
const failed = process.exitCode === 1;
console.log(failed ? '\nreversal suite FAILED' : '\nreversal suite passed');

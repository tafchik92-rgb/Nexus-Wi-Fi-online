/* ============================================================
   Responsive audit — drives every screen, as both roles, at seven
   form factors, and fails on anything a person could not reach.

   It looks for five things, all of which this app has had:
     · content wider than the screen with no scroller to reach it
       (a grid child at min-width:auto sized by a wide table)
     · controls pushed off either edge
     · controls present but zero-sized
     · tap targets under 28x24
     · text clipped with no ellipsis and no way to scroll

   Purely decorative layers are exempt: aria-hidden and
   pointer-events:none, they are meant to bleed past the viewport.

   Usage:
     # terminal 1
     firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test
     # terminal 2
     npx serve -l 4199 .
     node tests/responsive.test.mjs
   ============================================================ */
import fs from 'node:fs'; import path from 'node:path';
import { wipe, seedBulk } from './responsive.seed.mjs';

// Playwright is not a dependency of the app; this suite is opt-in.
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch (_) { /* try the next */ }
}
if (!chromium) {
  console.log('Playwright not installed — skipping the responsive audit.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const PROJECT = 'nexus-pos-fn-test';
// Offline mirror of the Firebase SDK, used only where gstatic is unreachable.
const SDK_DIR = process.env.NEXUS_SDK_MIRROR || '';
const ORIGIN = 'http://127.0.0.1:4199';

const VIEWPORTS = [
  { name: 'phone-small',  width: 320, height: 640, touch: true },
  { name: 'phone',        width: 390, height: 844, touch: true },
  { name: 'phone-large',  width: 430, height: 932, touch: true },
  { name: 'tablet-port',  width: 768, height: 1024, touch: true },
  { name: 'tablet-land',  width: 1024, height: 768, touch: true },
  { name: 'laptop',       width: 1280, height: 800, touch: false },
  { name: 'desktop',      width: 1920, height: 1080, touch: false },
];

const wire = async (target) => {
  if (SDK_DIR && fs.existsSync(SDK_DIR)) {
    await target.route(/gstatic\.com\/firebasejs\//, (r) => {
      const f = path.join(SDK_DIR, r.request().url().split('/').pop());
      if (!fs.existsSync(f)) return r.abort();
      r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f, 'utf8') });
    });
  }
  await target.route('**/firebase-config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: `window.NEXUS_FIREBASE_CONFIG = ${JSON.stringify({ apiKey:'fake-api-key', authDomain:`${PROJECT}.firebaseapp.com`, projectId:PROJECT, useEmulators:true, emulatorHost:'127.0.0.1' })};` }));
};

// ---- the probe that runs inside the page ----
const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = { pageOverflow: 0, wide: [], offscreen: [], invisible: [], tiny: [], clipped: [] };
  out.pageOverflow = Math.max(0, document.documentElement.scrollWidth - vw);

  const scrollableAncestor = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const ov = getComputedStyle(n).overflowX;
      if (ov === 'auto' || ov === 'scroll') return n;
    }
    return null;
  };
  const label = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 22);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    for (let n = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  };

  // Purely decorative layers are meant to bleed past the viewport: they are
  // aria-hidden, cannot be clicked, and are clipped at the root on purpose.
  const decorative = (el) => {
    for (let n = el; n; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true'
          && getComputedStyle(n).pointerEvents === 'none') return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || decorative(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const scroller = scrollableAncestor(el);

    // wider than the screen, and not inside something meant to scroll
    if (!scroller && r.width > vw + 1 && el.children.length === 0) out.wide.push(label(el) + ' w=' + Math.round(r.width));
    // pushed past either edge
    if (!scroller && (r.left < -1 || r.right > vw + 1)) {
      const tag = el.tagName.toLowerCase();
      if (['button','input','select','textarea','a'].includes(tag)) {
        out.offscreen.push(label(el) + ' x=' + Math.round(r.left) + '..' + Math.round(r.right));
      }
    }
    // text cut off with no way to see it
    if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && !scroller) {
      const s = getComputedStyle(el);
      if (s.textOverflow !== 'ellipsis' && s.overflow === 'visible') { /* visible overflow is fine */ }
      else if (s.textOverflow !== 'ellipsis') out.clipped.push(label(el));
    }
  }

  // interactive things that are present but unusable. A checkbox's real hit
  // area is the label wrapping it, so measure that rather than the box.
  for (const el of document.querySelectorAll('button, input, select, textarea, [data-action]')) {
    if (el.closest('[hidden]') || !visible(el)) continue;
    const hit = (el.type === 'checkbox' || el.type === 'radio')
      ? (el.closest('label') || el) : el;
    const r = hit.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { out.invisible.push(label(el)); continue; }
    if (r.width < 28 || r.height < 24) out.tiny.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return out;
})()`;

const findings = [];
const record = (where, vp, res) => {
  const add = (kind, items) => { for (const i of new Set(items)) findings.push({ where, vp: vp.name, w: vp.width, kind, detail: i }); };
  if (res.pageOverflow > 1) findings.push({ where, vp: vp.name, w: vp.width, kind: 'page-overflow', detail: res.pageOverflow + 'px' });
  add('wider-than-screen', res.wide);
  add('off-screen-control', res.offscreen);
  add('zero-size-control', res.invisible);
  add('tap-target', res.tiny);
  add('clipped-text', res.clipped);
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

// ---------- one-time seed ----------
await wipe();
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await wire(ctx);
  const p = await ctx.newPage();
  await p.goto(ORIGIN + '/index.html'); await p.waitForTimeout(3500);
  await p.click('[data-action=show-setup]'); await p.waitForTimeout(300);
  await p.fill('#st-name','Ada Mensah'); await p.fill('#st-code','ADM-01');
  await p.fill('#st-pin','1234'); await p.fill('#st-site','Gloy Mine Camp');
  await p.click('#setup-form button[type=submit]'); await p.waitForTimeout(5000);
  await p.click('.subtab[data-sub=sites]'); await p.waitForTimeout(700);
  await p.fill('#s-name','Riverside Kiosk'); await p.fill('#s-code','S-02');
  await p.click('#site-form button[type=submit]'); await p.waitForTimeout(2500);
  const ids = await p.evaluate(() => ({ sites: db.sites.map(s => s.id), me: session.userId }));
  await p.click('.subtab[data-sub=team]'); await p.waitForTimeout(700);
  await p.fill('#u-name','Kira Vance'); await p.fill('#u-code','AG-01');
  await p.selectOption('#u-role','agent'); await p.fill('#u-pin','1111'); await p.waitForTimeout(400);
  for (const s of ids.sites) await p.check(`#u-sites input[value="${s}"]`).catch(() => {});
  await p.click('#user-form button[type=submit]'); await p.waitForTimeout(3000);
  const agentId = await p.evaluate(() => (db.users.find(u => u.code === 'AG-01') || {}).id);
  await seedBulk(ids.sites, agentId, 'Kira Vance', ids.me);
  await ctx.close();
  console.log('seeded 2 sites, 2 staff, ~146 vouchers, ~78 sales, 12 accounts, 12 payments\n');
}

// ---------- walk every screen at every size ----------
for (const vp of VIEWPORTS) {
  const ctx = await b.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch, isMobile: vp.touch, deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  await wire(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', e => findings.push({ where: 'boot', vp: vp.name, w: vp.width, kind: 'page-error', detail: e.message }));
  await p.goto(ORIGIN + '/index.html'); await p.waitForTimeout(3200);

  record('login', vp, await p.evaluate(PROBE));

  // ---- admin ----
  await p.fill('#lg-code','ADM-01'); await p.fill('#lg-pin','1234');
  await p.click('#login-form button[type=submit]'); await p.waitForTimeout(5500);
  for (const sub of ['dash','team','vouchers','sites','credit','reports','cloud']) {
    await p.click(`.subtab[data-sub=${sub}]`).catch(() => {});
    await p.waitForTimeout(700);
    record('admin/' + sub, vp, await p.evaluate(PROBE));
  }
  await p.click('.tab[data-tab=terminal]'); await p.waitForTimeout(800);
  record('admin/terminal', vp, await p.evaluate(PROBE));

  // modals, which are their own layout problem
  await p.click('.tab[data-tab=admin]'); await p.click('.subtab[data-sub=credit]'); await p.waitForTimeout(900);
  for (const [name, open, close] of [
    ['statement', '[data-action=view-account]', '#stmt-close'],
    ['settle', '[data-action=settle]', '#settle-cancel'],
  ]) {
    const btn = p.locator(open).first();
    if (await btn.count()) {
      await btn.click(); await p.waitForTimeout(700);
      record('modal/' + name, vp, await p.evaluate(PROBE));
      await p.click(close).catch(() => {});
      await p.waitForTimeout(400);
    }
  }
  await p.click('#btn-pin'); await p.waitForTimeout(500);
  record('modal/pin', vp, await p.evaluate(PROBE));
  await p.click('#pin-cancel'); await p.waitForTimeout(300);

  // ---- agent ----
  await p.click('#btn-logout'); await p.waitForTimeout(2500);
  await p.fill('#lg-code','AG-01'); await p.fill('#lg-pin','1111');
  await p.click('#login-form button[type=submit]'); await p.waitForTimeout(5500);
  for (const tab of ['terminal','credit','monthend']) {
    await p.click(`.tab[data-tab=${tab}]`).catch(() => {});
    await p.waitForTimeout(800);
    record('agent/' + tab, vp, await p.evaluate(PROBE));
  }
  await ctx.close();
  process.stdout.write(`  ${vp.name} (${vp.width}px) done\n`);
}
await b.close();

// ---------- report ----------
console.log('\n================ FINDINGS ================');
const byKind = {};
for (const f of findings) (byKind[f.kind] ||= []).push(f);
if (!findings.length) console.log('none');
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n### ${kind} — ${list.length}`);
  const byDetail = {};
  for (const f of list) (byDetail[`${f.where} :: ${f.detail}`] ||= []).push(f.vp);
  for (const [k, vps] of Object.entries(byDetail).slice(0, 40)) {
    console.log(`  ${k}\n      at: ${[...new Set(vps)].join(', ')}`);
  }
}
console.log(`\n${findings.length} responsive findings`);
process.exit(findings.length ? 1 : 0);

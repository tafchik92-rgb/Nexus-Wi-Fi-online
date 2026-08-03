/* ============================================================
   NEXUS//POS — boot, login, routing, wiring
   Load order: importer.js → core.js → admin.js → agent.js → app.js
   ============================================================ */
"use strict";

const ui = {
  tab: "admin",
  sub: "dash",
  filters: { q: "", type: "all", pay: "all", range: "all" },
  vfilters: { type: "all", status: "all" },
  uploadType: "V5",
  sale: { type: null, pay: "cash" },
  settleAccount: null,
};

/* ------------------------------------------------------------
   Login
   ------------------------------------------------------------ */
function showLogin() {
  $("#login").hidden = false;
  $("#app").hidden = true;
  $("#login-err").hidden = true;
  $("#setup-err").hidden = true;
  $("#lg-code").value = "";
  $("#lg-pin").value = "";

  // Cloud mode: only the server knows who exists, so always offer the login,
  // with setup reachable for a brand-new Firebase project.
  if (typeof Backend !== "undefined" && Backend.enabled) {
    $("#setup-box").hidden = !ui.showSetup;
    $("#login-box").hidden = !!ui.showSetup;
    $("#setup-lead").innerHTML = `Setting up a <b>new cloud shop</b>. This creates the founding administrator on your Firebase project — it only works while no staff exist there.`;
    $("#st-site-wrap").hidden = false;
    $("#setup-demo-wrap").hidden = true;
    $("#login-hint").innerHTML = `Cloud mode — <button type="button" class="link-btn" data-action="show-setup">set up a new shop</button>`;
    setTimeout(() => $(ui.showSetup ? "#st-name" : "#lg-code").focus(), 40);
    return;
  }

  // If nobody can sign in — an empty store, or one restored from v1 where no
  // account has a PIN — show setup. Otherwise the login form is unwinnable.
  const usable = usableUsers();
  const stranded = usable.length === 0 && db.users.length > 0;
  $("#setup-box").hidden = usable.length > 0;
  $("#login-box").hidden = usable.length === 0;

  if (usable.length === 0) {
    $("#setup-lead").innerHTML = stranded
      ? `This device holds <b>${db.users.length} staff record(s)</b> restored from an older version, but none of them has a PIN yet — so nobody can sign in. Create an administrator to take control. <b>Your sites, vouchers and sales are kept</b>, and you can set each agent's PIN from the Team page.`
      : `No staff accounts exist on this device yet. Create the administrator who will run the shop — you'll sign in with this code and PIN from now on.`;
    // don't offer to invent a second site over migrated data
    $("#st-site-wrap").hidden = db.sites.length > 0;
    $("#setup-demo-wrap").hidden = stranded;
    setTimeout(() => $("#st-name").focus(), 40);
    return;
  }

  // Show the codes that actually work — the one thing the operator needs.
  const codes = usable.slice(0, 4).map((u) => `<b>${esc(u.code)}</b>`).join(" · ");
  $("#login-hint").innerHTML =
    `${usable.length} account(s) can sign in — ${codes}${usable.length > 4 ? " …" : ""}`;
  setTimeout(() => $("#lg-code").focus(), 40);
}

// First-run bootstrap: create the founding administrator + first site, then sign in.
async function runSetup() {
  const name = $("#st-name").value.trim();
  const code = $("#st-code").value.trim().toUpperCase();
  const pin = $("#st-pin").value.trim();
  const siteName = $("#st-site").value.trim();
  const fail = (msg) => {
    const err = $("#setup-err");
    err.textContent = msg;
    err.hidden = false;
    $("#setup-form").classList.add("shake");
    setTimeout(() => $("#setup-form").classList.remove("shake"), 500);
  };
  if (!name) return fail("Enter your name.");
  if (!code) return fail("Enter a staff code — you'll sign in with it.");
  if (!/^\d{4,8}$/.test(pin)) return fail("PIN must be 4–8 digits.");
  if (!siteName) return fail("Name your first site.");

  if (typeof Backend !== "undefined" && Backend.enabled) {
    try {
      if (!Backend.ready) await Backend.connect();
      const staff = await Backend.bootstrap({ name, code, pin, siteName });
      await Backend.startSync(() => renderAll());
      session = { userId: staff.id, siteId: "" };
      saveSession();
      enterApp();
      return toast(`Welcome, ${name} — this shop is now live on your Firebase project`);
    } catch (e) {
      return fail(cloudError(e));
    }
  }

  if (db.users.some((u) => u.code.toUpperCase() === code)) {
    return fail(`Code ${code} already belongs to a staff record — pick another.`);
  }

  const now = new Date().toISOString();
  // Keep whatever a v1 migration brought across; only open a site if there is none.
  if (db.sites.length === 0) {
    db.sites.push({ id: uid(), name: siteName, code: "S-01", status: "active", createdAt: now });
  }
  const admin = { id: uid(), name, code, role: "admin", salt: "", pinHash: "", siteIds: [], status: "active", createdAt: now };
  await setUserPin(admin, pin);
  db.users.push(admin);
  save();

  session = { userId: admin.id, siteId: "" };
  saveSession();
  enterApp();
  const stranded = db.users.filter((u) => !u.pinHash).length;
  toast(stranded
    ? `Welcome, ${name} — ${stranded} restored account(s) need a PIN, set them on the Team page`
    : `Welcome, ${name} — ${db.sites[0].name} is open for business`);
}

async function attemptLogin(code, pin) {
  const fail = (msg) => {
    const err = $("#login-err");
    err.textContent = msg;
    err.hidden = false;
    $("#login-form").classList.add("shake");
    setTimeout(() => $("#login-form").classList.remove("shake"), 500);
  };

  // Cloud mode: the PIN is checked on the server and never trusted here.
  if (typeof Backend !== "undefined" && Backend.enabled) {
    try {
      if (!Backend.ready) await Backend.connect();
      const staff = await Backend.signIn(String(code).trim(), String(pin).trim());
      await Backend.startSync(() => renderAll());
      session = { userId: staff.id, siteId: staff.role === "admin" ? "" : (staff.siteIds || [])[0] || "" };
      saveSession();
      enterApp();
      return toast(`Signed in as ${staff.name}`);
    } catch (e) {
      return fail(cloudError(e));
    }
  }

  const user = db.users.find((u) => u.code.toUpperCase() === String(code).trim().toUpperCase());
  if (!user) return fail("No staff member with that code.");
  if (user.status !== "active") return fail("That account is suspended. Ask an administrator.");
  if (!user.pinHash) return fail("No PIN set for this account. An administrator must reset it.");
  if (!(await verifyPin(user, pin))) return fail("Incorrect PIN.");

  const sites = sitesForUser(user);
  session = { userId: user.id, siteId: user.role === "admin" ? "" : (sites[0] || {}).id || "" };
  saveSession();
  enterApp();
  toast(`Signed in as ${user.name}`);
}

// Firebase errors arrive prefixed; show the message the function actually sent.
function cloudError(e) {
  const msg = String((e && e.message) || e || "Unknown error").replace(/^.*?\/\s*/, "");
  return msg || "Could not reach the server.";
}

function logout() {
  if (typeof Backend !== "undefined" && Backend.enabled && Backend.ready) Backend.signOut().catch(() => {});
  clearSession();
  ui.sale = { type: null, pay: "cash" };
  showLogin();
}

/* ------------------------------------------------------------
   Shell — role-aware chrome
   ------------------------------------------------------------ */
function enterApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const user = currentUser();
  const admin = isAdmin();

  $("#user-name").textContent = user.name;
  $("#user-meta").innerHTML = `${esc(user.code)} · ${roleChip(user.role)}`;

  // tabs by role
  $$(".tab").forEach((b) => {
    const adminOnly = b.dataset.role === "admin";
    b.hidden = adminOnly && !admin;
  });
  if (!admin && (ui.tab === "admin")) ui.tab = "terminal";
  if (admin && !["admin", "terminal"].includes(ui.tab)) ui.tab = "admin";

  // site scope
  const sel = $("#site-scope");
  const sites = sitesForUser(user);
  sel.innerHTML = (admin ? `<option value="">ALL SITES</option>` : "") +
    sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  if (!admin && !sites.some((s) => s.id === session.siteId)) {
    session.siteId = (sites[0] || {}).id || "";
    saveSession();
  }
  sel.value = session.siteId || "";
  sel.disabled = sites.length <= 1 && !admin;

  setTab(ui.tab, ui.sub);
}

function setTab(tab, sub) {
  const admin = isAdmin();
  const allowed = admin ? ["admin", "terminal"] : ["terminal", "credit", "monthend"];
  ui.tab = allowed.includes(tab) ? tab : allowed[0];
  if (sub) ui.sub = sub;

  $$(".tab").forEach((b) => {
    const on = b.dataset.tab === ui.tab;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on);
  });
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${ui.tab}`));
  $$(".subtab").forEach((b) => b.classList.toggle("is-active", b.dataset.sub === ui.sub));
  $$(".subview").forEach((v) => v.classList.toggle("is-active", v.id === `sub-${ui.sub}`));

  const hash = ui.tab === "admin" ? `#admin/${ui.sub}` : `#${ui.tab}`;
  try {
    if (location.hash !== hash) history.replaceState(null, "", hash);
  } catch (_) { /* sandboxed host — routing still works in memory */ }
  renderAll();
}

function routeFromHash() {
  const [tab, sub] = location.hash.replace("#", "").split("/");
  setTab(tab || (isAdmin() ? "admin" : "terminal"),
    ["dash", "team", "vouchers", "sites", "credit", "reports", "cloud"].includes(sub) ? sub : undefined);
}

/* ------------------------------------------------------------
   Render orchestration
   ------------------------------------------------------------ */
function renderAll() {
  if (!session) return;
  if (isAdmin()) {
    renderTiles();
    renderChart();
    renderSales();
    renderTeam();
    renderSites();
    renderStockCards();
    renderVoucherSiteSelect();
    renderVouchers();
    renderAdminCredit();
    renderAdminReports();
    renderCloud();
    renderTerminal();
  } else {
    renderTerminal();
    renderAgentCredit();
    renderMonthEnd();
  }
}

function tickClock() {
  const now = new Date();
  $("#clock-time").textContent = now.toLocaleTimeString("en-US", { hour12: false });
  $("#clock-date").textContent = now
    .toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "2-digit" })
    .toUpperCase();
  const live = $("#ts-live");
  if (live) live.textContent = now.toLocaleString("en-US", { hour12: false });
}

/* ------------------------------------------------------------
   Demo data
   ------------------------------------------------------------ */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedDemo() {
  const rnd = mulberry32(20260803);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const old = new Date(Date.now() - 40 * 864e5).toISOString();

  const fresh = emptyDb();
  const sites = [
    { id: uid(), name: "Gloy Mine Camp", code: "S-01", status: "active", createdAt: old },
    { id: uid(), name: "Riverside Kiosk", code: "S-02", status: "active", createdAt: old },
  ];
  fresh.sites = sites;

  const staff = [
    { name: "Ada Mensah",  code: "ADM-01", role: "admin", pin: "1234", siteIds: [] },
    { name: "Kira Vance",  code: "AG-01",  role: "agent", pin: "1111", siteIds: [sites[0].id] },
    { name: "Dex Moreau",  code: "AG-02",  role: "agent", pin: "2222", siteIds: [sites[0].id] },
    { name: "Zara Chen",   code: "AG-03",  role: "agent", pin: "3333", siteIds: [sites[1].id] },
  ];
  for (const s of staff) {
    const u = { id: uid(), name: s.name, code: s.code, role: s.role, salt: "", pinHash: "", siteIds: s.siteIds, status: "active", createdAt: old };
    await setUserPin(u, s.pin);
    fresh.users.push(u);
  }

  db = fresh;   // generateCodes and the helpers read the live db
  const agents = db.users.filter((u) => u.role === "agent");

  for (const site of sites) {
    // stocked deep enough that six weeks of backfilled trading leaves stock on hand
    for (const [type, n] of [["V5", 180], ["V10", 140], ["REC", 30]]) {
      for (const code of generateCodes(type, n, site.id)) {
        db.vouchers.push({ id: uid(), code, type, siteId: site.id, status: "available", batch: "B-DEMO", uploadedAt: old });
      }
    }
  }

  const names = ["Amina Diallo", "Joel Okafor", "Rita Mensah", "Kwame Boateng", "Lena Fischer",
    "Samuel Ade", "Nadia Toure", "Ibrahim Kane", "Grace Owusu", "Tunde Bello",
    "Fatima Sy", "Marcus Cole", "Awa Ndiaye", "Daniel Osei", "Chloe Martin"];
  const phoneOf = (i) => `+233 ${String(200000000 + i * 731913).slice(0, 9).replace(/(\d{2})(\d{3})(\d{4})/, "$1 $2 $3")}`;

  // ~6 weeks of trading so last month and this month both have data
  for (let daysAgo = 41; daysAgo >= 0; daysAgo--) {
    const count = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < count; i++) {
      const agent = pick(agents);
      const site = agent.siteIds[0];
      const roll = rnd();
      const type = roll < 0.5 ? "V5" : roll < 0.93 ? "V10" : "REC";
      const voucher = db.vouchers.find((v) => v.type === type && v.siteId === site && v.status === "available");
      if (!voucher) continue;
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(8 + Math.floor(rnd() * 12), Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
      if (d.getTime() > Date.now()) d.setTime(Date.now() - Math.floor(rnd() * 36e5));

      const price = VTYPES[type].price;
      const onCredit = price > 0 && rnd() < 0.3;
      const ni = Math.floor(rnd() * names.length);
      const customer = names[ni];
      const phone = rnd() < 0.7 ? phoneOf(ni) : "";
      const account = onCredit ? findOrCreateAccount(customer, phone, site) : null;
      if (account) account.createdAt = d.toISOString();

      voucher.status = "sold";
      db.sales.push({
        id: uid(), customer, phone,
        accountId: account ? account.id : null,
        voucherId: voucher.id, voucherCode: voucher.code, type, price,
        pay: onCredit ? "credit" : "cash",
        agentId: agent.id, agentName: agent.name,
        siteId: site, soldAt: d.toISOString(),
      });
    }
  }

  // settle roughly two thirds of the debt so both states are visible
  _rev++;
  for (const acc of db.accounts.slice()) {
    const bal = accountBalance(acc.id);
    if (bal <= 0) continue;
    const roll = rnd();
    if (roll < 0.35) continue;                                  // still fully owing
    const amount = roll < 0.7 ? Math.max(5, Math.round(bal * 0.5)) : bal;   // partial vs cleared
    const collector = pick(agents.filter((a) => a.siteIds[0] === acc.siteId)) || pick(agents);
    const p = recordPayment(acc.id, amount, pick(["cash", "cash", "mobile", "bank"]), "", collector.id);
    if (p) {
      const d = new Date(Date.now() - Math.floor(rnd() * 20) * 864e5);
      p.receivedAt = d.toISOString();
    }
  }

  save();
  session = null;
  showLogin();
  $("#login-hint").innerHTML = `DEMO SHOP LOADED — admin <b>ADM-01</b> pin <b>1234</b> · agents <b>AG-01</b>/1111 · <b>AG-02</b>/2222 · <b>AG-03</b>/3333`;
  toast("Demo shop loaded — sign in with ADM-01 / 1234");
}

// Rename a site in place. Records reference sites by id, so the change is
// retroactive: past sales, vouchers and closed reports follow the new name.
function saveSiteEdit() {
  const site = siteById(ui.editSite);
  if (!site) return;
  const name = $("#site-edit-name").value.trim();
  const code = $("#site-edit-code").value.trim().toUpperCase();
  if (!name) return toast("Site name cannot be empty", "err");
  if (!code) return toast("Site code cannot be empty", "err");
  if (db.sites.some((s) => s.id !== site.id && s.code === code)) {
    return toast(`Site code ${code} is already in use`, "err");
  }
  const was = site.name;
  site.name = name;
  site.code = code;
  touch("sites", site);
  save();
  $("#modal-site").hidden = true;
  enterApp();     // refresh the header's site selector labels too
  toast(was === name ? `Site ${name} updated` : `${was} renamed to ${name}`);
}

/* ------------------------------------------------------------
   Wiring
   ------------------------------------------------------------ */
function wire() {
  // login
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await attemptLogin($("#lg-code").value, $("#lg-pin").value);
  });
  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await runSetup();
  });
  $("#btn-logout").addEventListener("click", logout);

  // shell
  $$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$(".subtab").forEach((b) => b.addEventListener("click", () => setTab("admin", b.dataset.sub)));
  window.addEventListener("hashchange", () => { if (session) routeFromHash(); });
  $("#site-scope").addEventListener("change", (e) => {
    session.siteId = e.target.value;
    saveSession();
    renderAll();
  });

  // PIN change
  $("#btn-pin").addEventListener("click", () => {
    $("#pin-old").value = ""; $("#pin-new").value = "";
    $("#modal-pin").hidden = false;
  });
  $("#pin-save").addEventListener("click", async () => {
    const user = currentUser();
    const oldPin = $("#pin-old").value.trim(), newPin = $("#pin-new").value.trim();
    if (!/^\d{4,8}$/.test(newPin)) return toast("New PIN must be 4–8 digits", "err");
    if (cloudMode()) {
      try {
        await Backend.call("changePin", { currentPin: oldPin, newPin });
      } catch (e) { return toast(cloudError(e), "err"); }
    } else {
      if (user.pinHash && !(await verifyPin(user, oldPin))) return toast("Current PIN is incorrect", "err");
      await setUserPin(user, newPin);
      save();
    }
    $("#modal-pin").hidden = true;
    toast("PIN updated");
  });

  // admin: dashboard filters
  $("#f-q").addEventListener("input", (e) => { ui.filters.q = e.target.value; renderSales(); });
  $("#f-type").addEventListener("change", (e) => { ui.filters.type = e.target.value; renderSales(); });
  $("#f-pay").addEventListener("change", (e) => { ui.filters.pay = e.target.value; renderSales(); });
  $("#f-range").addEventListener("change", (e) => { ui.filters.range = e.target.value; renderSales(); });
  $("#btn-export").addEventListener("click", exportSalesCSV);

  // admin: team + sites
  $("#user-form").addEventListener("submit", (e) => { e.preventDefault(); addUser(e.target); });
  $("#u-role").addEventListener("change", (e) => {
    $("#u-sites-wrap").hidden = e.target.value === "admin";
  });
  $("#site-form").addEventListener("submit", (e) => { e.preventDefault(); addSite(e.target); });

  // admin: vouchers
  $$("#up-type .seg-btn").forEach((b) => b.addEventListener("click", () => {
    ui.uploadType = b.dataset.vtype;
    $$("#up-type .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
  }));
  $("#voucher-form").addEventListener("submit", (e) => {
    e.preventDefault();
    uploadVouchers(ui.uploadType, $("#up-codes").value);
    $("#up-codes").value = "";
  });
  $("#btn-generate").addEventListener("click", () => {
    const n = Math.min(500, Math.max(1, parseInt($("#gen-count").value, 10) || 20));
    $("#up-codes").value = generateCodes(ui.uploadType, n, uploadSiteId()).join("\n");
    toast(`${n} unique ${VTYPES[ui.uploadType].label} codes generated — review and upload`);
  });
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) await importVoucherFile(file);
    e.target.value = "";
  });
  $("#vf-type").addEventListener("change", (e) => { ui.vfilters.type = e.target.value; renderVouchers(); });
  $("#vf-status").addEventListener("change", (e) => { ui.vfilters.status = e.target.value; renderVouchers(); });

  // cloud panel
  $("#cloud-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    let config;
    try {
      config = JSON.parse($("#cloud-config").value.trim());
    } catch (_) { return toast("That is not valid JSON — paste the firebaseConfig object", "err"); }
    if (!config.projectId || !config.apiKey) return toast("Config needs at least apiKey and projectId", "err");
    config.useEmulators = $("#cloud-emulators").checked;
    Backend.saveConfig(config, true);
    try {
      await Backend.connect();
      toast("Connected — sign out and back in to authenticate against the server");
    } catch (err) {
      Backend.enabled = false;
      return toast(cloudError(err), "err");
    }
    renderAll();
  });
  $("#btn-cloud-disable").addEventListener("click", async () => {
    if (!(await confirmDlg("Switch back to local mode? Cloud data stays on the server; this browser returns to its own local store."))) return;
    if (Backend.ready) await Backend.signOut().catch(() => {});
    Backend.clearConfig();
    Backend.ready = false;
    clearSession();
    db = loadDb();
    showLogin();
    toast("Back in local mode");
  });
  $("#btn-cloud-push").addEventListener("click", pushLocalToCloud);

  // credit search
  $("#credit-q").addEventListener("input", renderAdminCredit);
  $("#ag-credit-q").addEventListener("input", renderAgentCredit);

  // reports
  $("#rep-period").addEventListener("change", renderAdminReports);
  $("#btn-rep-export").addEventListener("click", exportReportCSV);
  $("#me-period").addEventListener("change", renderMonthEnd);
  $("#btn-close-month").addEventListener("click", closeMonth);
  $("#btn-me-export").addEventListener("click", exportMonthCSV);

  // terminal
  $("#pkg-cards").addEventListener("click", (e) => {
    const card = e.target.closest(".pkg");
    if (!card || card.disabled) return;
    ui.sale.type = card.dataset.vtype;
    renderTerminal();
  });
  $$("#pay-seg .seg-btn").forEach((b) => b.addEventListener("click", () => {
    ui.sale.pay = b.dataset.pay;
    $$("#pay-seg .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
    $("#credit-warn").hidden = ui.sale.pay !== "credit";
    renderSummary();
  }));
  $("#c-name").addEventListener("input", renderSummary);
  $("#c-phone").addEventListener("input", renderSummary);
  $("#btn-complete").addEventListener("click", completeSale);

  // modals
  $("#btn-copy").addEventListener("click", copyCode);
  $("#btn-new-sale").addEventListener("click", () => { $("#modal-sale").hidden = true; $("#c-name").focus(); });
  $("#settle-confirm").addEventListener("click", submitSettlement);
  $("#settle-cancel").addEventListener("click", () => { $("#modal-settle").hidden = true; });
  $("#settle-full").addEventListener("click", () => {
    $("#settle-amount").value = accountBalance(ui.settleAccount);
  });
  $("#site-edit-cancel").addEventListener("click", () => { $("#modal-site").hidden = true; });
  $("#site-edit-save").addEventListener("click", saveSiteEdit);
  $("#stmt-close").addEventListener("click", () => { $("#modal-stmt").hidden = true; });
  $("#stmt-settle").addEventListener("click", (e) => {
    $("#modal-stmt").hidden = true;
    openSettle(e.target.dataset.id);
  });
  $("#receipt-done").addEventListener("click", () => { $("#modal-receipt").hidden = true; });
  $("#pin-cancel").addEventListener("click", () => { $("#modal-pin").hidden = true; });

  $$(".modal").forEach((m) => m.addEventListener("click", (e) => {
    if (e.target === m && m.id !== "modal-confirm") m.hidden = true;
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".modal").forEach((m) => { m.hidden = true; });
  });

  // delegated row actions
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === "settle") return openSettle(id);
    if (action === "view-account") return openStatement(id);

    if (action === "toggle-user") {
      const u = userById(id);
      if (!u || (session && u.id === session.userId)) return;
      u.status = u.status === "active" ? "inactive" : "active";
      touch("users", u);
      save(); renderAll();
      toast(`${u.name} is now ${u.status.toUpperCase()}`);
    }
    if (action === "del-user") {
      const u = userById(id);
      if (!u || db.sales.some((s) => s.agentId === id)) return;
      if (!(await confirmDlg(`Remove ${u.name} (${u.code}) from the team?`))) return;
      db.users = db.users.filter((x) => x.id !== id);
      drop("users", id);
      save(); renderAll();
      toast(`${u.name} removed`);
    }
    if (action === "reset-pin") {
      const u = userById(id);
      if (!u) return;
      if (!(await confirmDlg(`Reset the PIN for ${u.name}? A new 4-digit PIN will be shown once.`))) return;
      let pin;
      if (cloudMode()) {
        try {
          pin = (await Backend.call("resetPin", { staffId: u.id })).pin;
        } catch (e) { return toast(cloudError(e), "err"); }
      } else {
        pin = String(Math.floor(1000 + Math.random() * 9000));
        await setUserPin(u, pin);
        save();
      }
      renderAll();
      $("#sale-code").textContent = pin;
      $("#sale-details").innerHTML = `<div><dt>STAFF</dt><dd>${esc(u.name)} · ${esc(u.code)}</dd></div>
        <div><dt>NOTE</dt><dd>Share this PIN with them and have them change it after signing in.</dd></div>`;
      $("#modal-sale-title").textContent = "✓ PIN RESET";
      $("#modal-sale-sub").textContent = "NEW PIN — SHOWN ONCE";
      $("#modal-sale").hidden = false;
    }
    if (action === "edit-site") {
      const s = siteById(id);
      if (!s) return;
      ui.editSite = id;
      $("#site-edit-name").value = s.name;
      $("#site-edit-code").value = s.code;
      $("#modal-site").hidden = false;
      setTimeout(() => $("#site-edit-name").select(), 30);
    }
    if (action === "toggle-site") {
      const s = siteById(id);
      if (!s) return;
      s.status = s.status === "active" ? "closed" : "active";
      touch("sites", s);
      save(); renderAll();
      toast(`${s.name} is now ${s.status.toUpperCase()}`);
    }
    if (action === "del-site") {
      const s = siteById(id);
      if (!s) return;
      if (db.sales.some((x) => x.siteId === id) || db.vouchers.some((v) => v.siteId === id)) {
        return toast("That site has records — close it instead of deleting", "err");
      }
      if (!(await confirmDlg(`Delete site ${s.name}?`))) return;
      db.sites = db.sites.filter((x) => x.id !== id);
      drop("sites", id);
      for (const u of db.users) {
        if ((u.siteIds || []).includes(id)) {
          u.siteIds = u.siteIds.filter((x) => x !== id);
          touch("users", u);
        }
      }
      save(); renderAll();
      toast(`Site ${s.name} deleted`);
    }
    if (action === "del-voucher") {
      const v = db.vouchers.find((x) => x.id === id);
      if (!v || v.status !== "available") return;
      if (!(await confirmDlg(`Purge voucher ${v.code} from ${siteName(v.siteId)}?`))) return;
      db.vouchers = db.vouchers.filter((x) => x.id !== id);
      drop("vouchers", id);
      save(); renderAll();
      toast(`Voucher ${v.code} purged`);
    }
    if (action === "show-setup") { ui.showSetup = true; showLogin(); return; }
    if (action === "seed") {
      if (cloudMode()) return toast("Demo data is local-mode only — it would overwrite your cloud shop", "err");
      if (db.users.length || db.sales.length) {
        if (!(await confirmDlg("Replace ALL current data with the demo shop?"))) return;
      }
      await seedDemo();
    }
    if (action === "reset") {
      if (cloudMode()) return toast("Disconnect from cloud mode before wiping local data", "err");
      if (!(await confirmDlg("Wipe every site, staff account, voucher, sale and payment? This cannot be undone."))) return;
      storage.removeItem(DB_KEY);
      storage.removeItem(LEGACY_KEY);
      clearSession();
      db = emptyDb();
      showLogin();
      toast("All data wiped — terminal reset", "err");
    }
  });
}

// One-way import of this browser's local store into the cloud project.
async function pushLocalToCloud() {
  if (!cloudMode()) return toast("Connect to a Firebase project first", "err");
  if (!isAdmin()) return toast("Administrators only", "err");
  const local = readLocalStore();
  if (!local) return toast("No local data to push", "err");
  if (!(await confirmDlg(
    `Push ${local.sales.length} sales, ${local.vouchers.length} vouchers and ${local.users.length} staff to ${Backend.config.projectId}? Existing cloud records with the same id are overwritten. Staff PINs cannot be moved — imported agents get a fresh PIN you reset from the Team page.`))) return;

  const btn = $("#btn-cloud-push");
  btn.disabled = true;
  const original = btn.textContent;
  try {
    const report = await Backend.pushLocalData(local, (msg) => { btn.textContent = "⇪ " + msg; });
    toast(`Pushed ${report.sales} sales · ${report.vouchers} vouchers · ${report.staff} new staff · ${report.payments} payments`);
  } catch (e) {
    toast(cloudError(e), "err");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
    renderAll();
  }
}

/* ------------------------------------------------------------
   Boot
   ------------------------------------------------------------ */
(async function boot() {
  db = loadDb();
  Backend.loadConfig();
  wire();
  tickClock();
  setInterval(tickClock, 1000);

  const period = monthKey(new Date());
  $("#rep-period").value = period;
  $("#me-period").value = period;

  const params = new URLSearchParams(location.search);
  if (params.get("demo") === "1" && db.users.length === 0) await seedDemo();

  // Cloud mode always re-authenticates on load: a stale local session must
  // never stand in for a server-issued token.
  if (typeof Backend !== "undefined" && Backend.enabled) {
    clearSession();
    try {
      await Backend.connect();
      showLogin();
      return;
    } catch (e) {
      // Unreachable backend must not become a login nobody can pass —
      // drop back to local mode and say why.
      Backend.enabled = false;
      Backend.ready = false;
      toast(`Cloud unavailable — working locally. ${cloudError(e)}`, "err");
    }
  }

  session = loadSession();
  if (session) enterApp(); else showLogin();
  if (session) routeFromHash();
})();

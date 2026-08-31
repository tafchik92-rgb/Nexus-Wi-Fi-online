/* ============================================================
   NEXUS//POS — boot, login, routing, wiring
   Load order: importer.js → core.js → admin.js → agent.js → app.js
   ============================================================ */
"use strict";

const ui = {
  tab: "admin",
  sub: "dash",
  filters: { q: "", type: "all", pay: "all", range: "all" },
  vfilters: { type: "all", status: "all", batch: "all" },
  uploadType: "V5",
  sale: { type: null, pay: "cash" },
  settleAccount: null,
  reverseSale: null,
  reverseOutcome: "restocked",
};

/* ------------------------------------------------------------
   Login

   The shop lives on the server, so the login screen has four states:
   no project configured yet, configured but unreachable, first-run
   setup, and the ordinary staff sign-in.
   ------------------------------------------------------------ */
const hasConfig = () =>
  !!(Backend.config && Backend.config.apiKey && Backend.config.projectId);

// The boot card owns the screen until we know which card to show. Every path
// out of boot goes through showLogin or enterApp, so both must retire it —
// otherwise a slow or failed start leaves the operator staring at nothing.
const bootSays = (html) => {
  const note = $("#boot-note");
  if (note) note.innerHTML = html;
};
const endBoot = () => {
  const boot = $("#boot");
  if (boot) boot.hidden = true;
};

function showLogin() {
  endBoot();
  $("#login").hidden = false;
  $("#app").hidden = true;
  $("#login-err").hidden = true;
  $("#setup-err").hidden = true;
  $("#lg-code").value = "";
  $("#lg-pin").value = "";

  const state = !hasConfig() ? "connect"
    : !Backend.ready ? "offline"
    : ui.showSetup ? "setup"
    : "login";

  $("#connect-box").hidden = state !== "connect";
  $("#offline-box").hidden = state !== "offline";
  $("#setup-box").hidden   = state !== "setup";
  $("#login-box").hidden   = state !== "login";

  if (state === "connect") {
    const box = $("#cn-config");
    if (!box.value.trim() && Backend.config) box.value = JSON.stringify(Backend.config, null, 2);
    setTimeout(() => box.focus(), 40);
    return;
  }

  if (state === "offline") {
    $("#offline-project").textContent = (Backend.config || {}).projectId || "—";
    const detail = $("#offline-detail");
    detail.hidden = !detail.textContent.trim();
    return;
  }

  if (state === "setup") {
    $("#setup-lead").innerHTML =
      `Setting up a <b>new shop</b> on <b>${esc(Backend.config.projectId)}</b>. This creates the founding administrator on the server — it only works while no staff exist there yet. ` +
      `<button type="button" class="link-btn" data-action="show-login">back to sign in</button>`;
    setTimeout(() => $("#st-name").focus(), 40);
    return;
  }

  renderInstall();
  $("#login-hint").innerHTML =
    `Signing in against <b>${esc(Backend.config.projectId)}</b> — every till shares these records.<br>` +
    `<button type="button" class="link-btn" data-action="show-setup">set up a new shop</button> · ` +
    `<button type="button" class="link-btn" data-action="diagnose">diagnostics</button>`;
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

  try {
    if (!Backend.ready) await Backend.connect();
    const staff = await Backend.bootstrap({ name, code, pin, siteName });
    await Backend.startSync(onSync);
    session = { userId: staff.id, siteId: "" };
    saveSession();
    ui.showSetup = false;
    enterApp();
    toast(`Welcome, ${name} — ${siteName} is open for business`);
  } catch (e) {
    fail(cloudError(e));
  }
}

// The PIN is checked by the signIn function and never trusted in the browser.
async function attemptLogin(code, pin) {
  const fail = (msg) => {
    const err = $("#login-err");
    err.textContent = msg;
    err.hidden = false;
    $("#login-form").classList.add("shake");
    setTimeout(() => $("#login-form").classList.remove("shake"), 500);
  };

  try {
    if (!Backend.ready) await Backend.connect();
    const staff = await Backend.signIn(String(code).trim(), String(pin).trim());
    await Backend.startSync(onSync);
    session = {
      userId: staff.id,
      siteId: staff.role === "admin" ? savedScope() : (staff.siteIds || [])[0] || "",
    };
    saveSession();
    enterApp();
    toast(`Signed in as ${staff.name}`);
  } catch (e) {
    fail(cloudError(e));
  }
}

// Firebase errors arrive prefixed; show the message the function actually sent.
function cloudError(e) {
  let msg = String((e && e.message) || e || "Unknown error");
  if (/network-request-failed|Failed to fetch|didn't respond/i.test(msg)) {
    return "Could not reach Firebase. Check the connection, then run backend diagnostics.";
  }
  msg = msg.replace(/^Firebase:\s*(Error\s*)?(\([^)]+\):?\s*)?/i, "").replace(/^.*?\/\s*/, "");
  // A bare "internal" means the call never produced a real answer — the
  // function is missing, blocked, or crashed. Diagnostics can tell which.
  if (/^internal$/i.test(msg.trim())) {
    return "Server error (internal) — the backend call never completed. Run backend diagnostics to see exactly what is missing.";
  }
  return msg || "Could not reach the server.";
}

const DIAG_ICON = { ok: "✓", warn: "!", fail: "✗" };

// The first diagnostic: what this device is running, and whether it is the
// build that is actually deployed. Reported as a warning rather than a
// failure — stale code is a real problem, but the app in front of you is
// still working, and a red cross here would send people hunting the wrong one.
async function versionCheck() {
  const name = "App version";
  // Not the probe's return value: an offline probe answers null while a
  // newer build found a minute ago is still the truth.
  const [, worker] = await Promise.all([
    AppVersion.checkForUpdate(),
    AppVersion.workerBuild(),
  ]);
  const latest = AppVersion.latest;

  if (!AppVersion.stamped) {
    return { level: "warn", name,
      detail: `${AppVersion.full} — served from a source checkout, so there is no build stamp to compare.`,
      fix: "Deploy with `bash deploy.sh --with-hosting` (or `npm run build`) to stamp the build." };
  }

  if (AppVersion.updateAvailable()) {
    return { level: "warn", name,
      detail: `Running ${AppVersion.full}, built ${AppVersion.builtLabel}. Version ${latest.release} (build ${latest.build}) is deployed.`,
      fix: "Tap the version in the header, or reload this page, to move this till onto it." };
  }

  if (worker && worker !== AppVersion.build) {
    return { level: "warn", name,
      detail: `${AppVersion.full}, but the cached app shell on this device is build ${worker}.`,
      fix: "Reload the page — the two will match once the worker has taken the new shell." };
  }

  return { level: "ok", name,
    detail: `${AppVersion.full}, built ${AppVersion.builtLabel}. This is the deployed build.` };
}
async function runDiagnostics() {
  const modal = $("#modal-diag");
  const list = $("#diag-list");
  modal.hidden = false;
  list.innerHTML = `<li class="diag-row"><span class="dim">Running checks…</span></li>`;
  $("#diag-summary").textContent = "";
  try {
    if (!Backend.config) Backend.loadConfig();
    // Which build is answering matters before any of the backend results are
    // read: half of "the app is broken" has turned out to be one device
    // running code an older release left behind.
    const results = [await versionCheck()].concat(await Backend.diagnose());
    const fails = results.filter((r) => r.level === "fail").length;
    // Warnings used to be invisible up here, so the header could read ALL
    // CLEAR with an amber row directly beneath it.
    const warns = results.filter((r) => r.level === "warn").length;
    $("#diag-summary").innerHTML = fails > 0
      ? `<span class="chip chip-sold"><i></i>${fails} PROBLEM${fails === 1 ? "" : "S"}</span>`
      : warns > 0
        ? `<span class="chip chip-v10"><i></i>${warns} WARNING${warns === 1 ? "" : "S"}</span>`
        : `<span class="chip chip-ok"><i></i>ALL CLEAR</span>`;
    list.innerHTML = results.map((r) => `
      <li class="diag-row diag-${r.level}">
        <span class="diag-icon">${DIAG_ICON[r.level] || "?"}</span>
        <span class="diag-body">
          <b>${esc(r.name)}</b>
          <span class="diag-detail">${esc(r.detail)}</span>
          ${r.fix ? `<span class="diag-fix">→ ${esc(r.fix)}</span>` : ""}
        </span>
      </li>`).join("");
  } catch (e) {
    list.innerHTML = `<li class="diag-row diag-fail"><span class="diag-icon">✗</span><span class="diag-body"><b>Diagnostics failed</b><span class="diag-detail">${esc(String(e && e.message || e))}</span></span></li>`;
  }
}

/* ------------------------------------------------------------
   Suspension ends the shift that is already open
   ------------------------------------------------------------ */
// The rules now refuse a suspended member's writes, which is the boundary
// that matters. This is the other half of it. A till whose writes are about
// to be refused should say so and close, not go on taking orders and fail at
// the last step — an agent watching COMPLETE SALE bounce with no explanation
// will assume the app is broken and keep trying.
//
// Every snapshot passes through here, and the staff directory is one of the
// collections an agent listens to, so the update that suspends them is itself
// what ends the session. Their own record disappearing counts too: removed
// from the team is not a lesser case than suspended.
let sessionEnding = false;
function guardSession() {
  if (!session || sessionEnding) return false;
  const me = userById(session.userId);
  if (me && me.status === "active") return false;

  sessionEnding = true;
  const why = me
    ? "Your account has been suspended. Ask an administrator."
    : "Your account has been removed from this shop.";
  // showLogin() clears the error line, so the reason goes up after it runs.
  logout().finally(() => {
    sessionEnding = false;
    const err = $("#login-err");
    if (err) { err.textContent = why; err.hidden = false; }
    toast(why, "err");
  });
  return true;
}

// What every sync callback does: end the shift if it is over, otherwise draw.
const onSync = () => { if (!guardSession()) renderAll(); };

async function logout() {
  db = emptyDb();                 // don't leave one shift's records on screen
  clearSession();
  ui.sale = { type: null, pay: "cash" };
  ui.showSetup = false;
  showLogin();
  // Awaited, not fired and forgotten: signing out purges the cached documents,
  // and the next sign-in must not race a half-finished teardown — that is how
  // the previous user's records would survive into the next shift.
  if (Backend.ready) await Backend.signOut().catch(() => {});
}

/* ------------------------------------------------------------
   Shell — role-aware chrome
   ------------------------------------------------------------ */
function enterApp() {
  const user = currentUser();
  // Without this the next line throws on a null user, and it throws *after*
  // the shell has been revealed — leaving every panel empty and every tab
  // showing, because the markup is still in its default state. A blank till
  // that says nothing is the worst possible failure here.
  if (!user) return strandedSession();

  endBoot();
  $("#login").hidden = true;
  $("#app").hidden = false;
  const admin = isAdmin();

  $("#user-name").textContent = user.name;
  $("#user-meta").innerHTML = `${esc(user.code)} · ${roleChip(user.role)}`;

  // tabs by role
  // Hide what the role cannot open. The CREDIT and MONTH-END tabs are the
  // agent's own views; an admin has the same ground under Admin → CREDIT and
  // Admin → REPORTS. They used to be shown to admins but rejected by setTab,
  // so clicking them simply did nothing.
  $$(".tab").forEach((b) => {
    const role = b.dataset.role;
    b.hidden = (role === "admin" && !admin) || (role === "agent" && admin);
  });
  if (!admin && (ui.tab === "admin")) ui.tab = "terminal";
  if (admin && !["admin", "terminal"].includes(ui.tab)) ui.tab = "admin";

  renderSiteScope();
  setTab(ui.tab, ui.sub);
}

// The header's site picker. This lives in renderAll, not just enterApp:
// opening a site used to leave it missing from this list until the operator
// signed out and back in, so a shop could be stocked at a site nobody could
// then switch the till to.
function renderSiteScope() {
  const user = currentUser();
  if (!user) return;
  const admin = isAdmin();
  const sel = $("#site-scope");
  const sites = sitesForUser(user);

  sel.innerHTML = (admin ? `<option value="">ALL SITES</option>` : "") +
    sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  // A remembered scope can point at a site that has since been deleted, or
  // that this staff member no longer covers — silently fall back rather than
  // showing empty dashboards for a site that is not in the list.
  if (session.siteId && !sites.some((s) => s.id === session.siteId)) {
    session.siteId = admin ? "" : (sites[0] || {}).id || "";
    saveSession();
  } else if (!admin && !session.siteId) {
    session.siteId = (sites[0] || {}).id || "";
    saveSession();
  }
  sel.value = session.siteId || "";
  sel.disabled = sites.length <= 1 && !admin;
}

// Signed in, but the staff directory does not contain this person. Either the
// listeners were refused, or the record was deleted mid-session. Say which,
// and get them back to a screen with a button on it.
function strandedSession() {
  const reason = Backend.status === "error"
    ? `The shop refused to send your staff record: ${Backend.error}`
    : "Your staff record was not found in the shop — it may have been removed.";
  Backend.signOut().catch(() => {});
  db = emptyDb();
  clearSession();
  showLogin();
  toast(`${reason} Sign in again, or run diagnostics.`, "err");
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
  renderModeChip();
  renderInstall();
  renderSiteScope();
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

// Says plainly whether the till is talking to the shop right now — the
// difference between "that sale is missing" and "we lost the link".
function renderModeChip() {
  const chip = $("#mode-chip");
  if (!chip) return;
  const state = Backend.status === "online" && Backend.ready ? "online"
    : Backend.status === "error" ? "error" : "offline";
  chip.className = "mode-chip mode-" + state;
  chip.textContent = state === "online" ? "☁ SHARED SHOP"
    : state === "error" ? "☁ SYNC ERROR"
    : "☁ NO CONNECTION";
  chip.title = state === "online"
    ? "Connected — every till sees the same stock and sales"
    : state === "error"
      ? `Firestore rejected the connection: ${Backend.error || "see diagnostics"}`
      : "No link to the shop. Reports still read from cache; a code can only be issued online.";
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
  // First run on a fresh deployment: the app must be pointed at a Firebase
  // project before anyone can sign in, since there is nowhere else for the
  // staff records to live.
  $("#connect-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    let config;
    try {
      config = parseFirebaseConfig($("#cn-config").value);
    } catch (err) { return toast(err.message, "err"); }
    if (!config.projectId || !config.apiKey) {
      return toast("Config needs at least apiKey and projectId — copy the whole object", "err");
    }
    Backend.saveConfig(config);
    await connectAndRestore();
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
    const oldPin = $("#pin-old").value.trim(), newPin = $("#pin-new").value.trim();
    if (!/^\d{4,8}$/.test(newPin)) return toast("New PIN must be 4–8 digits", "err");
    try {
      await Backend.call("changePin", { currentPin: oldPin, newPin });
    } catch (e) { return toast(cloudError(e), "err"); }
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
  $("#vf-batch").addEventListener("change", (e) => { ui.vfilters.batch = e.target.value; renderVouchers(); });
  $("#btn-purge-filtered").addEventListener("click", purgeFilteredVouchers);

  // cloud panel
  $("#cloud-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    let config;
    try {
      config = parseFirebaseConfig($("#cloud-config").value);
    } catch (err) { return toast(err.message, "err"); }
    if (!config.projectId || !config.apiKey) {
      return toast("Config needs at least apiKey and projectId — copy the whole object", "err");
    }
    // Realtime Database is a different product; this app stores in Firestore.
    if (config.databaseURL && !config.projectId) delete config.databaseURL;
    config.useEmulators = $("#cloud-emulators").checked;
    // Emulators only exist on the machine running them. Ticking this on a
    // phone or a hosted page points the app at a 127.0.0.1 that is not there.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (config.useEmulators && !local) {
      if (!(await confirmDlg(
        `"Use local emulators" is ticked, but this page is served from ${location.hostname || "a file"} — not your development machine. The app would try to reach emulators on 127.0.0.1 and fail. Connect to the real ${config.projectId} project instead?`))) return;
      config.useEmulators = false;
      $("#cloud-emulators").checked = false;
    }
    // Repointing the app at a different project invalidates this session:
    // the staff record and its token belong to the old one.
    if (Backend.config && Backend.config.projectId !== config.projectId) {
      if (!(await confirmDlg(
        `Switch this till from ${Backend.config.projectId} to ${config.projectId}? Everyone signed in here is signed out, and the app reloads against the new project.`))) return;
    }
    Backend.saveConfig(config);
    if (Backend.ready) await Backend.signOut().catch(() => {});
    location.reload();
  });
  $("#btn-cloud-push").addEventListener("click", pushLocalToCloud);
  $("#btn-cloud-repair").addEventListener("click", repairPaymentSites);
  $("#cloud-emulators").addEventListener("change", (e) => {
    $("#cloud-emu-warn").hidden = !e.target.checked;
  });

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
  // reversing a sale
  $("#rev-cancel").addEventListener("click", () => { $("#modal-reverse").hidden = true; });
  $("#rev-confirm").addEventListener("click", submitReversal);
  $$("#rev-outcome .seg-btn").forEach((b) => b.addEventListener("click", () => {
    ui.reverseOutcome = b.dataset.outcome;
    $$("#rev-outcome .seg-btn").forEach((x) => {
      const on = x === b;
      x.classList.toggle("is-active", on);
      x.setAttribute("aria-checked", on);
    });
    $("#rev-outcome-hint").textContent = ui.reverseOutcome === "restocked"
      ? "The customer never received this code, so it returns to stock and can be sold again."
      : "The customer already has this code. It leaves stock for good and can never be sold again.";
  }));

  $("#site-edit-cancel").addEventListener("click", () => { $("#modal-site").hidden = true; });
  $("#site-edit-save").addEventListener("click", saveSiteEdit);
  $("#stmt-close").addEventListener("click", () => { $("#modal-stmt").hidden = true; });
  $("#stmt-settle").addEventListener("click", (e) => {
    $("#modal-stmt").hidden = true;
    openSettle(e.target.dataset.id);
  });
  $("#receipt-done").addEventListener("click", () => { $("#modal-receipt").hidden = true; });
  $("#diag-close").addEventListener("click", () => { $("#modal-diag").hidden = true; });
  $("#diag-rerun").addEventListener("click", runDiagnostics);
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
    if (action === "reverse-sale") return openReversal(id);
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
      try {
        pin = (await Backend.call("resetPin", { staffId: u.id })).pin;
      } catch (e) { return toast(cloudError(e), "err"); }
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
    if (action === "show-login") { ui.showSetup = false; showLogin(); return; }
    if (action === "diagnose") return runDiagnostics();
    if (action === "retry-connect") {
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = "◈ CONNECTING…";
      await connectAndRestore();
      btn.textContent = was;
      btn.disabled = false;
      return;
    }
    if (action === "change-project") {
      Backend.clearConfig();
      ui.showSetup = false;
      showLogin();
      return;
    }
  });
}

// One-way import of a till's old device-only store into the shop.
async function pushLocalToCloud() {
  if (!cloudMode()) return toast("Not connected to the shop", "err");
  if (!isAdmin()) return toast("Administrators only", "err");
  const local = readLocalStore();
  if (!local) return toast("No older records found in this browser", "err");
  if (!(await confirmDlg(
    `Push ${local.sales.length} sales, ${local.vouchers.length} vouchers and ${local.users.length} staff to ${Backend.config.projectId}? Existing records with the same id are overwritten. Staff PINs cannot be moved — imported agents get a fresh PIN you reset from the Team page.`))) return;

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
   Install to the device

   A till belongs on a home screen, launching full screen without a
   browser bar. Chrome will offer that on its own, but only through a
   small address-bar icon most people never notice — so ask plainly.
   iOS has no install event at all; there the only route is Share → Add
   to Home Screen, which has to be described rather than triggered.
   ------------------------------------------------------------ */
let installPrompt = null;

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent || "") && !window.MSStream;

// Already running from the home screen — nothing left to offer.
const isInstalled = () => {
  try {
    return window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: fullscreen)").matches
      || window.navigator.standalone === true;
  } catch (_) { return false; }
};

function renderInstall() {
  const offer = !isInstalled() && (!!installPrompt || isIOS());
  for (const id of ["#btn-install", "#btn-install-login"]) {
    const el = $(id);
    if (el) el.hidden = !offer;
  }
}

async function promptInstall() {
  // Chrome/Edge/Android: fire the real prompt we stashed earlier.
  if (installPrompt) {
    const deferred = installPrompt;
    installPrompt = null;              // a prompt can only be used once
    renderInstall();
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({ outcome: "dismissed" }));
    if (outcome !== "accepted") {
      installPrompt = deferred;        // they may want it later
      renderInstall();
    }
    return;
  }

  // iOS Safari, or a browser that has not offered a prompt: explain it.
  $("#install-steps").innerHTML = isIOS()
    ? `Open the <b>Share</b> menu at the bottom of Safari, choose <b>Add to Home Screen</b>, then <b>Add</b>.<br><br>` +
      `The till then launches full screen with its own icon. It must be Safari — Chrome on iOS cannot install web apps.`
    : `Use your browser's menu and choose <b>Install app</b> or <b>Add to Home screen</b>.<br><br>` +
      `If neither appears, the page is probably not being served over <b>HTTPS</b>, or it is running inside an embedded preview. Open the deployed address in its own browser tab.`;
  $("#modal-install").hidden = false;
}

function wireInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();               // keep it for our own button
    installPrompt = e;
    renderInstall();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    renderInstall();
    toast("Installed — launch NEXUS//POS from the home screen from now on");
  });
  $("#btn-install").addEventListener("click", promptInstall);
  $("#btn-install-login").addEventListener("click", promptInstall);
  $("#install-done").addEventListener("click", () => { $("#modal-install").hidden = true; });
  renderInstall();
}

/* ------------------------------------------------------------
   Version marker

   Shown in two places, for two different moments: in the header while
   the till is in use, and on the sign-in screen — which is where a till
   that will not work gets looked at, and where "what version is this?"
   is the first question worth answering.

   It is a marker, not decoration. Once a newer build is deployed the
   header turns amber and becomes the button that takes it, so an update
   is something staff can see and apply themselves without being talked
   through a hard refresh over the phone.
   ------------------------------------------------------------ */
function renderVersion() {
  const stale = AppVersion.updateAvailable();

  const head = $("#app-version");
  if (head) {
    head.textContent = stale ? `${AppVersion.label} ▸ UPDATE` : AppVersion.label;
    head.classList.toggle("is-stale", stale);
    head.title = stale
      ? `Version ${AppVersion.latest.release} has been released — tap to update this till`
      : AppVersion.stamped
        ? `${AppVersion.full} — built ${AppVersion.builtLabel}`
        : `${AppVersion.full} — running from a source checkout, not a build`;
  }

  const foot = $("#login-version");
  if (foot) {
    foot.textContent = AppVersion.stamped
      ? `${AppVersion.full} · ${AppVersion.builtLabel}`
      : AppVersion.full;
  }
}

// Tapping the marker: take the update if there is one, otherwise just say
// what this till is running. On a phone there is no hover, so the title
// attribute alone would never be readable.
async function versionTapped() {
  if (AppVersion.updateAvailable()) {
    toast("Updating this till…");
    await AppVersion.applyUpdate();
    return;
  }
  const worker = await AppVersion.workerBuild();
  const skew = worker && AppVersion.stamped && worker !== AppVersion.build;
  toast(
    `${AppVersion.full}${AppVersion.stamped ? ` · built ${AppVersion.builtLabel}` : ""}` +
    (skew ? ` · cached shell ${worker} — reload to clear` : ""),
    skew ? "err" : "ok");
}

function wireVersion() {
  renderVersion();
  const head = $("#app-version");
  if (head) head.addEventListener("click", versionTapped);

  // Tills stay open all day, so a release deployed at noon would otherwise
  // go unnoticed until somebody happened to reload.
  AppVersion.watch((latest) => {
    renderVersion();
    toast(`Version ${latest.release} is available — tap the version in the header to update`);
  });
}

/* ------------------------------------------------------------
   Boot
   ------------------------------------------------------------ */
// The service worker caches the app shell so the till launches instantly and
// survives a flaky link. file:// has no worker support, and a failure here
// must never block the app.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;

  // When a new worker replaces an old one, this page is still running whatever
  // the old one served — which for one launch can be the previous release. An
  // agent on stale code makes queries the rules refuse and sees an empty till,
  // while an administrator on the same device is fine, because the old queries
  // are ones only an administrator may make. Reload once so the page is running
  // one release, not two.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Nothing stale on a first install, and never yank the page out from under
    // somebody mid-sale — by then the app is on screen and it can wait.
    if (!hadController || reloading || !$("#app").hidden) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// Opens the link to the shop and picks up whoever is already signed in on
// this device. Firebase Auth holds the session, so a reload mid-shift does
// not mean typing a PIN again — but the token, and the role claims the
// security rules read from it, still come from the server.
async function connectAndRestore() {
  if (!Backend.config) { showLogin(); return; }

  // A slow first launch is a big download, not a hang. Say so, and offer the
  // escape hatch if it drags on, rather than showing a frozen screen.
  bootSays(`Loading the terminal…<br><span class="dim">first launch downloads it once</span>`);
  const slow = setTimeout(() => bootSays(
    `Still loading — a slow connection makes the first launch long.<br>` +
    `<button type="button" class="link-btn" data-action="diagnose">run diagnostics</button>`), 6000);

  try {
    if (!Backend.ready) await Backend.connect();
  } catch (e) {
    clearTimeout(slow);
    Backend.ready = false;
    $("#offline-detail").textContent = cloudError(e);
    showLogin();
    return;
  }
  clearTimeout(slow);

  // Anything below this point failing must still land on a usable screen.
  try {
    const uid = await Backend.restoreSession();
    if (!uid) { showLogin(); return; }

    bootSays("Signing you back in…");
    await Backend.startSync(onSync);
    const me = userById(uid);
    if (!me || me.status !== "active") {
      // Removed or suspended while signed in — or the listeners were refused.
      await Backend.signOut().catch(() => {});
      db = emptyDb();
      clearSession();
      showLogin();
      if (Backend.status === "error") toast(`Could not read the shop: ${Backend.error}`, "err");
      return;
    }

    session = { userId: uid, siteId: savedScope() };
    enterApp();
    routeFromHash();
  } catch (e) {
    // Don't strand the operator on the boot card over a restore that failed.
    await Backend.signOut().catch(() => {});
    db = emptyDb();
    clearSession();
    showLogin();
    toast(`Could not restore your session — sign in again. ${cloudError(e)}`, "err");
  }
}

(async function boot() {
  try {
    registerServiceWorker();
    Backend.loadConfig();
    wire();
    wireInstall();
    wireVersion();
    tickClock();
    setInterval(tickClock, 1000);

    const period = monthKey(new Date());
    $("#rep-period").value = period;
    $("#me-period").value = period;

    await connectAndRestore();
  } catch (e) {
    // Last line of defence: a blank screen tells the operator nothing and
    // gives them nothing to do. Always land somewhere with a button on it.
    console.error("Boot failed:", e);
    const detail = $("#offline-detail");
    if (detail) detail.textContent = cloudError(e);
    try { showLogin(); } catch (_) { endBoot(); }
  }
})();

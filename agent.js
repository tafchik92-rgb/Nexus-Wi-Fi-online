/* ============================================================
   NEXUS//POS — agent workspace
   Terminal · Credit accounts & settlement · Month-end closing
   ============================================================ */
"use strict";

/* ------------------------------------------------------------
   Sales terminal
   ------------------------------------------------------------ */
function renderTerminal() {
  const user = currentUser();
  if (!user) return;
  const site = currentSiteId() || (sitesForUser(user)[0] || {}).id || "";

  $("#term-operator").innerHTML = `
    <span class="op-name">${esc(user.name)}</span>
    <span class="op-meta">${esc(user.code)} · ${roleChip(user.role)}</span>`;
  $("#term-site").textContent = site ? siteName(site) : "NO SITE";

  $("#pkg-cards").innerHTML = TYPE_ORDER.map((t) => {
    const conf = VTYPES[t];
    const stock = cloudMode() ? Backend.heldFor(site, t).length : stockOf(t, site);
    const out = stock === 0;
    return `<button type="button" class="pkg ${ui.sale.type === t ? "is-selected" : ""}"
        data-vtype="${t}" ${out ? "disabled" : ""} role="radio" aria-checked="${ui.sale.type === t}">
      <p class="pkg-name"><i></i>${conf.label}</p>
      <p class="pkg-price">${conf.price > 0 ? money(conf.price) : "FREE"}</p>
      <p class="pkg-stock">${out ? "◼ DEPLETED" : `◆ ${cloudMode() ? "READY" : "STOCK"} ${stock}`}</p>
    </button>`;
  }).join("");

  $$("#pay-seg .seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.pay === ui.sale.pay));
  $("#credit-warn").hidden = ui.sale.pay !== "credit";

  renderSummary();
  renderAgentLog();
  if (cloudMode()) topUpReservations(site);
}

// Keep a working block of vouchers on this device for each group.
let _topUpBusy = false;
async function topUpReservations(siteId) {
  if (_topUpBusy || !siteId || typeof Backend === "undefined" || Backend.status !== "online") return;
  _topUpBusy = true;
  try {
    for (const t of TYPE_ORDER) {
      if (Backend.heldFor(siteId, t).length < 5) await Backend.topUp(siteId, t, 15);
    }
  } finally { _topUpBusy = false; }
}

// Existing debt for whoever is being typed into the client fields.
function pendingAccount() {
  const name = $("#c-name").value.trim();
  if (!name) return null;
  const site = currentSiteId() || (sitesForUser(currentUser())[0] || {}).id || "";
  const key = accountKey(name, $("#c-phone").value);
  return db.accounts.find((a) => a.siteId === site && accountKey(a.name, a.phone) === key) || null;
}

function renderSummary() {
  const user = currentUser();
  const conf = ui.sale.type ? VTYPES[ui.sale.type] : null;
  const name = $("#c-name").value.trim();
  const site = currentSiteId() || (sitesForUser(user)[0] || {}).id || "";

  $("#s-site").textContent = site ? siteName(site) : "—";
  $("#s-pkg").textContent = conf ? conf.label : "—";
  $("#s-cust").textContent = name || "—";
  $("#s-pay").textContent = ui.sale.pay.toUpperCase();
  $("#s-total").textContent = conf ? (conf.price > 0 ? money(conf.price) : "$0") : "$0";

  const acc = pendingAccount();
  const bal = acc ? accountBalance(acc.id) : 0;
  const warn = $("#s-existing");
  if (bal > 0) {
    warn.hidden = false;
    warn.innerHTML = `⚠ EXISTING DEBT ${money(bal)} — <button type="button" class="link-btn" data-action="settle" data-id="${acc.id}">SETTLE NOW</button>`;
  } else warn.hidden = true;

  $("#btn-complete").disabled = !(user && conf && name && site);
}

function renderAgentLog() {
  const list = $("#agent-log");
  const user = currentUser();
  const today = dayKey(new Date());
  const mine = db.sales
    .filter((s) => user && s.agentId === user.id && dayKey(s.soldAt) === today)
    .sort((a, b) => b.soldAt.localeCompare(a.soldAt));

  const cash = mine.filter((s) => s.pay === "cash").reduce((sum, s) => sum + s.price, 0);
  const credit = mine.filter((s) => s.pay === "credit").reduce((sum, s) => sum + s.price, 0);
  const collected = db.payments
    .filter((p) => user && p.receivedBy === user.id && dayKey(p.receivedAt) === today)
    .reduce((sum, p) => sum + p.amount, 0);

  $("#log-summary").innerHTML = `
    <div><dt>CASH SALES</dt><dd>${money(cash)}</dd></div>
    <div><dt>DEBT COLLECTED</dt><dd>${money(collected)}</dd></div>
    <div><dt>CREDIT ISSUED</dt><dd class="owed">${money(credit)}</dd></div>
    <div class="summary-total"><dt>CASH IN HAND</dt><dd>${money(cash + collected)}</dd></div>`;

  list.innerHTML = mine.length === 0
    ? `<li class="mini-log-empty">NO SALES LOGGED TODAY</li>`
    : mine.map((s) => `
      <li>
        <span class="log-t">${new Date(s.soldAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
        <span class="log-c">${esc(s.customer)}</span>
        <span class="log-p ${s.pay === "credit" ? "is-credit" : ""}">${s.price > 0 ? money(s.price) : "REC"}${s.pay === "credit" ? " ⓒ" : ""}</span>
      </li>`).join("");
}

function completeSale() {
  const user = currentUser();
  const site = currentSiteId() || (sitesForUser(user)[0] || {}).id || "";
  const nameField = $("#c-name");
  const customer = nameField.value.trim();

  const problems = [];
  if (!user) problems.push("sign in again");
  if (!site) problems.push("select a site");
  if (!ui.sale.type) problems.push("select a package");
  if (!customer) {
    problems.push("enter the customer name");
    nameField.classList.add("shake");
    setTimeout(() => nameField.classList.remove("shake"), 500);
  }
  if (problems.length) return toast("Cannot transmit — " + problems.join(", "), "err");

  // Cloud mode sells only from the block this device reserved, so an offline
  // till can never hand out a code another till has already sold.
  const voucher = cloudMode()
    ? Backend.takeHeld(site, ui.sale.type)
    : db.vouchers
        .filter((v) => v.type === ui.sale.type && v.status === "available" && v.siteId === site)
        .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))[0];
  if (!voucher) {
    renderAll();
    return toast(cloudMode()
      ? `No ${VTYPES[ui.sale.type].label} reserved on this device — reconnect to draw more stock`
      : `${VTYPES[ui.sale.type].label} stock depleted at ${siteName(site)}`, "err");
  }

  const phone = $("#c-phone").value.trim();
  const price = VTYPES[voucher.type].price;
  const onCredit = ui.sale.pay === "credit" && price > 0;
  const account = onCredit ? findOrCreateAccount(customer, phone, site) : null;

  voucher.status = "sold";
  touch("vouchers", voucher);
  const sale = {
    id: newId(), customer, phone,
    accountId: account ? account.id : null,
    voucherId: voucher.id, voucherCode: voucher.code, type: voucher.type, price,
    pay: onCredit ? "credit" : "cash",
    agentId: user.id, agentName: user.name,
    siteId: site,
    soldAt: new Date().toISOString(),     // purchase date — auto-captured
  };
  db.sales.push(sale);
  touch("sales", sale);
  save();

  $("#sale-code").textContent = sale.voucherCode;
  $("#sale-details").innerHTML = `
    <div><dt>CUSTOMER</dt><dd>${esc(sale.customer)}</dd></div>
    <div><dt>PACKAGE</dt><dd>${VTYPES[sale.type].label}</dd></div>
    <div><dt>PAYMENT</dt><dd>${sale.pay.toUpperCase()} — ${sale.price > 0 ? money(sale.price) : "$0"}</dd></div>
    <div><dt>SITE</dt><dd>${esc(siteName(sale.siteId))}</dd></div>
    <div><dt>AGENT</dt><dd>${esc(sale.agentName)}</dd></div>
    <div><dt>TIMESTAMP</dt><dd>${new Date(sale.soldAt).toLocaleString("en-US", { hour12: false })}</dd></div>
    ${account ? `<div><dt>ACCOUNT BALANCE</dt><dd class="owed">${money(accountBalance(account.id))}</dd></div>` : ""}`;
  $("#modal-sale").hidden = false;

  $("#c-name").value = "";
  $("#c-phone").value = "";
  ui.sale.type = null;
  renderAll();
}

async function copyCode() {
  const code = $("#sale-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Access code copied to clipboard");
}

/* ------------------------------------------------------------
   Agent credit view
   ------------------------------------------------------------ */
function renderAgentCredit() {
  const site = currentSiteId() || (sitesForUser(currentUser())[0] || {}).id || "";
  const open = openAccounts(site);
  const owed = open.reduce((sum, x) => sum + x.balance, 0);
  const user = currentUser();
  const myCollected = db.payments
    .filter((p) => user && p.receivedBy === user.id)
    .reduce((sum, p) => sum + p.amount, 0);

  $("#ag-credit-tiles").innerHTML = `
    <div class="tile tile-warn">
      <p class="tile-label">OUTSTANDING AT ${esc((siteName(site) || "").toUpperCase())}</p>
      <p class="tile-value">${moneyCompact(owed)}</p>
      <p class="tile-sub">${open.length} OPEN ACCOUNT${open.length === 1 ? "" : "S"}</p>
    </div>
    <div class="tile">
      <p class="tile-label">YOU COLLECTED</p>
      <p class="tile-value">${moneyCompact(myCollected)}</p>
      <p class="tile-sub">ACROSS ALL SETTLEMENTS YOU RECORDED</p>
    </div>`;

  renderAccountsTable("#ag-accounts-tbody", "#ag-accounts-empty", "#ag-accounts-table", site, false);
}

/* --- statement & settlement ---------------------------------- */
function openStatement(accountId) {
  const acc = accountById(accountId);
  if (!acc) return;
  const open = accountOpenSales(accountId);
  const pays = accountPayments(accountId);
  const balance = accountBalance(accountId);

  $("#stmt-title").textContent = acc.name;
  $("#stmt-sub").innerHTML = `${esc(acc.phone || "no contact")} · ${esc(siteName(acc.siteId))} · OPENED ${fmtDate(acc.createdAt)}`;
  $("#stmt-balance").textContent = money(balance);
  $("#stmt-open").innerHTML = open.length === 0
    ? `<p class="hint">No unpaid vouchers — this account is clear.</p>`
    : `<table class="grid-table"><thead><tr><th>DATE</th><th>VOUCHER</th><th>TYPE</th><th class="num">OWED</th></tr></thead><tbody>` +
      open.map((s) => `<tr>
        <td class="cell-date">${fmtDateTime(s.soldAt)}</td>
        <td class="cell-code">${esc(s.voucherCode)}</td>
        <td>${typeChip(s.type)}</td>
        <td class="num owed-strong">${money(saleOutstanding(s))}</td>
      </tr>`).join("") + `</tbody></table>`;

  $("#stmt-pays").innerHTML = pays.length === 0
    ? `<p class="hint">No payments recorded yet.</p>`
    : `<table class="grid-table"><thead><tr><th>DATE</th><th class="num">AMOUNT</th><th>METHOD</th><th>TAKEN BY</th></tr></thead><tbody>` +
      pays.map((p) => `<tr>
        <td class="cell-date">${fmtDateTime(p.receivedAt)}</td>
        <td class="num">${money(p.amount)}</td>
        <td>${esc(PAY_METHODS[p.method] || p.method)}</td>
        <td>${esc(p.receivedByName)}</td>
      </tr>`).join("") + `</tbody></table>`;

  $("#stmt-settle").dataset.id = accountId;
  $("#stmt-settle").hidden = balance <= 0;
  $("#modal-stmt").hidden = false;
}

function openSettle(accountId) {
  const acc = accountById(accountId);
  if (!acc) return;
  const balance = accountBalance(accountId);
  if (balance <= 0) return toast(`${acc.name} has no outstanding debt`, "err");

  ui.settleAccount = accountId;
  $("#settle-name").textContent = acc.name;
  $("#settle-meta").textContent = `${acc.phone || "no contact"} · ${siteName(acc.siteId)}`;
  $("#settle-balance").textContent = money(balance);
  $("#settle-open").innerHTML = accountOpenSales(accountId).map((s) => `
    <li><span class="mono">${esc(s.voucherCode)}</span><span class="dim">${fmtDate(s.soldAt)}</span><span class="owed-strong">${money(saleOutstanding(s))}</span></li>`).join("");
  const amt = $("#settle-amount");
  amt.value = balance;
  amt.max = balance;
  $("#settle-method").value = "cash";
  $("#settle-note").value = "";
  $("#modal-settle").hidden = false;
  setTimeout(() => amt.focus(), 30);
}

function submitSettlement() {
  const accountId = ui.settleAccount;
  const acc = accountById(accountId);
  if (!acc) return;
  const balance = accountBalance(accountId);
  const raw = parseFloat($("#settle-amount").value);
  if (!(raw > 0)) return toast("Enter an amount greater than zero", "err");
  const amount = Math.min(raw, balance);
  if (raw > balance) toast(`Capped at the ${money(balance)} owed`, "err");

  const payment = recordPayment(accountId, amount, $("#settle-method").value, $("#settle-note").value, session.userId);
  if (!payment) return toast("Nothing to settle on this account", "err");

  const left = accountBalance(accountId);
  $("#modal-settle").hidden = true;
  $("#receipt-amount").textContent = money(payment.amount);
  $("#receipt-details").innerHTML = `
    <div><dt>CUSTOMER</dt><dd>${esc(acc.name)}</dd></div>
    <div><dt>METHOD</dt><dd>${esc(PAY_METHODS[payment.method])}</dd></div>
    <div><dt>APPLIED TO</dt><dd>${payment.allocations.length} VOUCHER${payment.allocations.length === 1 ? "" : "S"}</dd></div>
    <div><dt>TAKEN BY</dt><dd>${esc(payment.receivedByName)}</dd></div>
    <div><dt>TIMESTAMP</dt><dd>${new Date(payment.receivedAt).toLocaleString("en-US", { hour12: false })}</dd></div>
    <div class="summary-total"><dt>BALANCE LEFT</dt><dd class="${left > 0 ? "owed" : "clear"}">${money(left)}</dd></div>`;
  $("#modal-receipt").hidden = false;
  renderAll();
  toast(left > 0
    ? `${money(payment.amount)} received — ${money(left)} still owed`
    : `${money(payment.amount)} received — ${acc.name} is fully settled`);
}

/* ------------------------------------------------------------
   Month-end closing
   ------------------------------------------------------------ */
function renderMonthEnd() {
  const user = currentUser();
  if (!user) return;
  const period = $("#me-period").value || monthKey(new Date());
  const site = currentSiteId() || (sitesForUser(user)[0] || {}).id || "";
  const closed = closingFor(user.id, period, site);
  const r = closed ? closed.totals : buildReport(user.id, period, site);

  $("#me-status").innerHTML = closed
    ? `<span class="chip chip-ok"><i></i>CLOSED ${fmtDateTime(closed.generatedAt)}</span>`
    : `<span class="chip chip-off"><i></i>OPEN PERIOD</span>`;

  $("#me-tiles").innerHTML = `
    <div class="tile tile-hero">
      <p class="tile-label">TOTAL CASH COLLECTED</p>
      <p class="tile-value">${money(r.totalCashCollected)}</p>
      <p class="tile-sub">SALES ${money(r.cashSalesTotal)} · SETTLEMENTS ${money(r.debtCollected)}</p>
    </div>
    <div class="tile tile-warn">
      <p class="tile-label">OUTSTANDING DEBT</p>
      <p class="tile-value">${money(r.unpaidFromPeriod)}</p>
      <p class="tile-sub">FROM ${money(r.creditIssued)} ISSUED ON CREDIT</p>
    </div>
    <div class="tile">
      <p class="tile-label">TRANSACTIONS</p>
      <p class="tile-value">${r.salesCount}</p>
      <p class="tile-sub">${r.cashCount} CASH · ${r.creditCount} CREDIT</p>
    </div>`;

  $("#me-breakdown").innerHTML = `
    <table class="grid-table">
      <thead><tr><th>LINE</th><th class="num">COUNT</th><th class="num">AMOUNT</th></tr></thead>
      <tbody>
        <tr><td>Cash sales</td><td class="num">${r.cashCount}</td><td class="num">${money(r.cashSalesTotal)}</td></tr>
        <tr><td>Debt settlements received</td><td class="num">${r.paymentsCount}</td><td class="num">${money(r.debtCollected)}</td></tr>
        <tr class="row-total"><td>Total cash collected</td><td class="num">—</td><td class="num strong">${money(r.totalCashCollected)}</td></tr>
        <tr><td>Credit issued</td><td class="num">${r.creditCount}</td><td class="num">${money(r.creditIssued)}</td></tr>
        <tr class="row-total"><td>Still outstanding from this month</td><td class="num">—</td><td class="num owed-strong">${money(r.unpaidFromPeriod)}</td></tr>
      </tbody>
    </table>
    <h3 class="mini-head">BY VOUCHER GROUP</h3>
    <table class="grid-table">
      <thead><tr><th>GROUP</th><th class="num">SOLD</th><th class="num">VALUE</th></tr></thead>
      <tbody>${TYPE_ORDER.map((t) => `
        <tr><td>${typeChip(t)}</td><td class="num">${r.byType[t].count}</td><td class="num">${money(r.byType[t].total)}</td></tr>`).join("")}
      </tbody>
    </table>
    <h3 class="mini-head">SETTLEMENTS BY METHOD</h3>
    <table class="grid-table">
      <thead><tr><th>METHOD</th><th class="num">AMOUNT</th></tr></thead>
      <tbody>${Object.keys(PAY_METHODS).map((m) => `
        <tr><td>${PAY_METHODS[m]}</td><td class="num">${money(r.byMethod[m] || 0)}</td></tr>`).join("")}
      </tbody>
    </table>`;

  $("#btn-close-month").disabled = !!closed;
  $("#btn-close-month").textContent = closed ? "✓ MONTH CLOSED" : "▣ CLOSE MONTH";
}

async function closeMonth() {
  const user = currentUser();
  const period = $("#me-period").value || monthKey(new Date());
  const site = currentSiteId() || (sitesForUser(user)[0] || {}).id || "";
  if (closingFor(user.id, period, site)) return toast("This period is already closed", "err");
  if (period > monthKey(new Date())) return toast("That month has not started yet", "err");

  const r = buildReport(user.id, period, site);
  if (!(await confirmDlg(
    `Close ${fmtMonth(period)} for ${user.name}? Totals are frozen: ${money(r.totalCashCollected)} collected, ${money(r.unpaidFromPeriod)} outstanding.`))) return;

  const closing = {
    id: newId(), userId: user.id, userName: user.name, siteId: site, period,
    generatedAt: new Date().toISOString(), totals: r,
  };
  db.closings.push(closing);
  touch("closings", closing);
  save(); renderAll();
  toast(`${fmtMonth(period)} closed — ${money(r.totalCashCollected)} collected`);
}

function exportMonthCSV() {
  const user = currentUser();
  const period = $("#me-period").value || monthKey(new Date());
  const site = currentSiteId() || (sitesForUser(user)[0] || {}).id || "";
  const closed = closingFor(user.id, period, site);
  const r = closed ? closed.totals : buildReport(user.id, period, site);

  const rows = [
    ["NEXUS//POS month-end statement"],
    ["Agent", user.name, user.code],
    ["Site", siteName(site)],
    ["Period", fmtMonth(period)],
    ["Status", closed ? `CLOSED ${new Date(closed.generatedAt).toISOString()}` : "OPEN"],
    [],
    ["Line", "Count", "Amount"],
    ["Cash sales", r.cashCount, r.cashSalesTotal],
    ["Debt settlements received", r.paymentsCount, r.debtCollected],
    ["TOTAL CASH COLLECTED", "", r.totalCashCollected],
    ["Credit issued", r.creditCount, r.creditIssued],
    ["OUTSTANDING FROM THIS MONTH", "", r.unpaidFromPeriod],
    [],
    ["Voucher group", "Sold", "Value"],
    ...TYPE_ORDER.map((t) => [VTYPES[t].label, r.byType[t].count, r.byType[t].total]),
    [],
    ["Settlement method", "Amount"],
    ...Object.keys(PAY_METHODS).map((m) => [PAY_METHODS[m], r.byMethod[m] || 0]),
  ];
  downloadCSV(`nexus-pos-monthend-${user.code}-${period}.csv`, rows);
  toast(`Exported the ${fmtMonth(period)} statement`);
}

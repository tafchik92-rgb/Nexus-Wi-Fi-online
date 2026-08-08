/* ============================================================
   NEXUS//POS — agent workspace
   Terminal · Credit accounts & settlement · Month-end closing
   ============================================================ */
"use strict";

/* ------------------------------------------------------------
   Sales terminal
   ------------------------------------------------------------ */
// A till sells from exactly one site. "ALL SITES" is a reporting view and
// means nothing here, so it is not silently resolved to whichever site
// happens to be first — that quietly sold the wrong site's stock and booked
// the takings against it. With a single site there is no ambiguity to raise.
function terminalSiteId() {
  const scoped = currentSiteId();
  if (scoped) return scoped;
  const mine = sitesForUser(currentUser());
  return mine.length === 1 ? mine[0].id : "";
}

function renderTerminal() {
  const user = currentUser();
  if (!user) return;
  const site = terminalSiteId();
  const choices = sitesForUser(user);

  $("#term-operator").innerHTML = `
    <span class="op-name">${esc(user.name)}</span>
    <span class="op-meta">${esc(user.code)} · ${roleChip(user.role)}</span>`;
  $("#term-site").textContent = site ? siteName(site)
    : choices.length ? "CHOOSE A SITE" : "NO SITE";

  // Real shared stock: what every till at this site can still sell.
  $("#pkg-cards").innerHTML = !site
    ? `<p class="pkg-hint">${choices.length
        ? `This till is set to <b>ALL SITES</b>, which is a reporting view — pick the site you are selling from in the header to see its stock.`
        : `You are not assigned to a site yet. An administrator can assign one from the Team page.`}</p>`
    : TYPE_ORDER.map((t) => {
    const conf = VTYPES[t];
    const stock = stockOf(t, site);
    const out = stock === 0;
    return `<button type="button" class="pkg ${ui.sale.type === t ? "is-selected" : ""}"
        data-vtype="${t}" ${out ? "disabled" : ""} role="radio" aria-checked="${ui.sale.type === t}">
      <p class="pkg-name"><i></i>${conf.label}</p>
      <p class="pkg-price">${conf.price > 0 ? money(conf.price) : "FREE"}</p>
      <p class="pkg-stock">${out ? "◼ DEPLETED" : `◆ STOCK ${stock}`}</p>
    </button>`;
  }).join("");

  $$("#pay-seg .seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.pay === ui.sale.pay));
  $("#credit-warn").hidden = ui.sale.pay !== "credit";

  renderSummary();
  renderAgentLog();
}

// Existing debt for whoever is being typed into the client fields.
function pendingAccount() {
  const name = $("#c-name").value.trim();
  if (!name) return null;
  const site = terminalSiteId();
  const key = accountKey(name, $("#c-phone").value);
  return db.accounts.find((a) => a.siteId === site && accountKey(a.name, a.phone) === key) || null;
}

function renderSummary() {
  const user = currentUser();
  const conf = ui.sale.type ? VTYPES[ui.sale.type] : null;
  const name = $("#c-name").value.trim();
  const site = terminalSiteId();

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
    .filter((s) => user && s.agentId === user.id && dayKey(s.soldAt) === today && !isReversed(s))
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

async function completeSale() {
  const user = currentUser();
  const site = terminalSiteId();
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

  const type = ui.sale.type;
  if (stockOf(type, site) === 0) {
    renderAll();
    return toast(`${VTYPES[type].label} stock depleted at ${siteName(site)}`, "err");
  }

  const phone = $("#c-phone").value.trim();
  const price = VTYPES[type].price;
  const onCredit = ui.sale.pay === "credit" && price > 0;
  // Resolved before the claim because the account id belongs in the sale
  // record; the stock check above keeps us from opening one we never use.
  const account = onCredit ? findOrCreateAccount(customer, phone, site) : null;

  const btn = $("#btn-complete");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "◈ ISSUING…";

  let sale;
  try {
    // The server decides which code this till gets — see Backend.claimAndSell.
    sale = await Backend.claimAndSell(site, type, (voucher) => ({
      id: newId(), customer, phone,
      accountId: account ? account.id : null,
      voucherId: voucher.id, voucherCode: voucher.code, type: voucher.type, price,
      pay: onCredit ? "credit" : "cash",
      agentId: user.id, agentName: user.name,
      siteId: site,
      soldAt: new Date().toISOString(),   // purchase date — auto-captured
    }));
  } catch (e) {
    const msg = String((e && e.message) || e);
    btn.textContent = label;
    btn.disabled = false;
    renderAll();
    if (msg === "OUT_OF_STOCK") return toast(`${VTYPES[type].label} stock depleted at ${siteName(site)}`, "err");
    if (msg === "CONTENDED") return toast("Another till took those codes — try again", "err");
    if (msg === "DENIED") {
      return toast(`The shop refused every ${VTYPES[type].label} at ${siteName(site)} — check you are assigned to this site, then sign out and back in.`, "err");
    }
    if (msg === "NO_CONNECTION") {
      return toast("No connection to the shop — a code can only be issued online. Nothing was charged.", "err");
    }
    if (msg === "TIMEOUT") {
      return toast("The shop did not answer. Check today's log before selling again — this one may still go through.", "err");
    }
    return toast(cloudError(e), "err");
  }

  btn.textContent = label;
  // Reflect the commit in the mirror right away so the stock count and the
  // day log update without waiting for the round trip. The next snapshot
  // replaces both collections wholesale, so this cannot drift or duplicate.
  const claimed = db.vouchers.find((v) => v.id === sale.voucherId);
  if (claimed) claimed.status = "sold";
  db.sales.push(sale);
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
  const site = terminalSiteId();
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

  // Which vouchers each payment actually cleared. Payments settle the oldest
  // debt first, so this is what answers "has last month's balance been
  // recovered yet" — without it a settlement is just a number and a date.
  const clearedBy = (p) => (p.allocations || []).map((a) => {
    const sale = db.sales.find((x) => x.id === a.saleId);
    if (!sale) return null;
    const part = a.amount < sale.price ? ` (${money(a.amount)} of ${money(sale.price)})` : "";
    return `${sale.voucherCode}${part} · ${fmtDate(sale.soldAt)}`;
  }).filter(Boolean);

  $("#stmt-pays").innerHTML = pays.length === 0
    ? `<p class="hint">No payments recorded yet.</p>`
    : `<table class="grid-table"><thead><tr><th>DATE</th><th class="num">AMOUNT</th><th>METHOD</th><th>TAKEN BY</th><th>CLEARED</th></tr></thead><tbody>` +
      pays.map((p) => {
        const cleared = clearedBy(p);
        return `<tr>
        <td class="cell-date">${fmtDateTime(p.receivedAt)}</td>
        <td class="num">${money(p.amount)}</td>
        <td>${esc(PAY_METHODS[p.method] || p.method)}</td>
        <td>${esc(p.receivedByName)}${p.note ? `<span class="cell-sub">${esc(p.note)}</span>` : ""}</td>
        <td class="cell-code">${cleared.length
          ? cleared.map((c) => `<span class="cell-sub">${esc(c)}</span>`).join("")
          : "<span class=\"cell-sub\">—</span>"}</td>
      </tr>`;
      }).join("") + `</tbody></table>`;

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
  const site = terminalSiteId();
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
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>LINE</th><th class="num">COUNT</th><th class="num">AMOUNT</th></tr></thead>
      <tbody>
        <tr><td>Cash sales</td><td class="num">${r.cashCount}</td><td class="num">${money(r.cashSalesTotal)}</td></tr>
        <tr><td>Debt settlements received</td><td class="num">${r.paymentsCount}</td><td class="num">${money(r.debtCollected)}</td></tr>
        <tr class="row-total"><td>Total cash collected</td><td class="num">—</td><td class="num strong">${money(r.totalCashCollected)}</td></tr>
        <tr><td>Credit issued</td><td class="num">${r.creditCount}</td><td class="num">${money(r.creditIssued)}</td></tr>
        <tr class="row-total"><td>Still outstanding from this month</td><td class="num">—</td><td class="num owed-strong">${money(r.unpaidFromPeriod)}</td></tr>
      </tbody>
    </table></div>
    <h3 class="mini-head">BY VOUCHER GROUP</h3>
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>GROUP</th><th class="num">SOLD</th><th class="num">VALUE</th></tr></thead>
      <tbody>${TYPE_ORDER.map((t) => `
        <tr><td>${typeChip(t)}</td><td class="num">${r.byType[t].count}</td><td class="num">${money(r.byType[t].total)}</td></tr>`).join("")}
      </tbody>
    </table></div>
    <h3 class="mini-head">SETTLEMENTS BY METHOD</h3>
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>METHOD</th><th class="num">AMOUNT</th></tr></thead>
      <tbody>${Object.keys(PAY_METHODS).map((m) => `
        <tr><td>${PAY_METHODS[m]}</td><td class="num">${money(r.byMethod[m] || 0)}</td></tr>`).join("")}
      </tbody>
    </table></div>`;

  $("#btn-close-month").disabled = !!closed;
  $("#btn-close-month").textContent = closed ? "✓ MONTH CLOSED" : "▣ CLOSE MONTH";
}

async function closeMonth() {
  const user = currentUser();
  const period = $("#me-period").value || monthKey(new Date());
  const site = terminalSiteId();
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
  const site = terminalSiteId();
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

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

function checkCheckoutDedup() {
  const alertEl = $("#c-dedup-alert");
  if (!alertEl) return;
  const name = $("#c-name").value.trim();
  const phone = $("#c-phone").value.trim();
  const site = terminalSiteId();

  if (!name || name.length < 2 || !site || ui.dedupDismissed) {
    alertEl.hidden = true;
    return;
  }

  // Exact account match already handled by existing debt banner
  const exact = pendingAccount();
  if (exact) {
    alertEl.hidden = true;
    return;
  }

  const similars = findSimilarAccounts(name, phone, site);
  if (similars.length > 0) {
    const top = similars[0];
    ui.dedupCandidate = top.account;
    const bal = accountBalance(top.account.id);
    const msgEl = $("#c-dedup-msg");
    const reason = top.matchType === "phone"
      ? `Phone matches existing client <b>${esc(top.account.name)}</b>`
      : `Similar client <b>${esc(top.account.name)}</b> found (${Math.round(top.similarity * 100)}% match)`;
    msgEl.innerHTML = `⚠ ${reason} · Current Balance: <b>${money(bal)}</b>`;
    alertEl.hidden = false;
  } else {
    ui.dedupCandidate = null;
    alertEl.hidden = true;
  }
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

  checkCheckoutDedup();

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

  // Deduplication check when selling on credit:
  // If not an exact match and a similar profile exists, verify with the operator
  const exactAcc = pendingAccount();
  if (onCredit && !exactAcc && !ui.dedupDismissed) {
    const similars = findSimilarAccounts(customer, phone, site);
    if (similars.length > 0) {
      const top = similars[0];
      ui.dedupCandidate = top.account;
      const verifyBody = $("#dedup-verify-body");
      if (verifyBody) {
        const topBal = accountBalance(top.account.id);
        const matchLabel = top.matchType === "phone" ? "Matching phone number" : `${Math.round(top.similarity * 100)}% name match`;
        verifyBody.innerHTML = `
          <dl class="summary">
            <div><dt>ENTERED NAME</dt><dd><b>${esc(customer)}</b> ${phone ? `· ${esc(phone)}` : ""}</dd></div>
            <div><dt>EXISTING PROFILE</dt><dd><b>${esc(top.account.name)}</b> ${top.account.phone ? `· ${esc(top.account.phone)}` : ""}</dd></div>
            <div><dt>SIMILARITY</dt><dd class="mono">${matchLabel}</dd></div>
            <div class="summary-total"><dt>EXISTING DEBT</dt><dd class="owed">${money(topBal)}</dd></div>
          </dl>
        `;
      }
      $("#modal-dedup-verify").hidden = false;
      return;
    }
  }

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
  ui.dedupDismissed = false;
  ui.dedupCandidate = null;
  if ($("#c-dedup-alert")) $("#c-dedup-alert").hidden = true;
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
  const myPayments = db.payments.filter((p) => user && p.receivedBy === user.id);
  const myCollected = myPayments.reduce((sum, p) => sum + p.amount, 0);

  const openCreditSales = open.flatMap((x) => accountOpenSales(x.account.id));
  const siteCreditSales = liveSales(site).filter((s) => s.pay === "credit");
  const siteCreditTotal = siteCreditSales.reduce((sum, s) => sum + s.price, 0);

  const openGroupCounts = countByVoucherGroup(openCreditSales);
  const mySettledCounts = settledByVoucherGroup(myPayments, site);
  const siteCreditCounts = countByVoucherGroup(siteCreditSales);

  const tilesEl = $("#ag-credit-tiles");
  if (tilesEl) {
    tilesEl.classList.remove("tiles-2");
    tilesEl.classList.add("tiles-3");
    tilesEl.innerHTML = `
      <div class="tile tile-warn">
        <p class="tile-label">OUTSTANDING AT ${esc((siteName(site) || "").toUpperCase())}</p>
        <p class="tile-value">${moneyCompact(owed)}</p>
        <p class="tile-sub">${open.length} OPEN ACCOUNT${open.length === 1 ? "" : "S"} · ${openCreditSales.length} UNPAID VOUCHER${openCreditSales.length === 1 ? "" : "S"}</p>
        ${renderTileGroupBreakdown(openGroupCounts, "UNPAID QTY BY GROUP")}
      </div>
      <div class="tile">
        <p class="tile-label">YOU COLLECTED</p>
        <p class="tile-value">${moneyCompact(myCollected)}</p>
        <p class="tile-sub">${myPayments.length} SETTLEMENT${myPayments.length === 1 ? "" : "S"} · ${mySettledCounts.total} VOUCHER${mySettledCounts.total === 1 ? "" : "S"} CLEARED</p>
        ${renderTileGroupBreakdown(mySettledCounts, "SETTLED QTY BY GROUP")}
      </div>
      <div class="tile">
        <p class="tile-label">TOTAL CREDIT ISSUED</p>
        <p class="tile-value">${moneyCompact(siteCreditTotal)}</p>
        <p class="tile-sub">${siteCreditSales.length} CREDIT VOUCHER${siteCreditSales.length === 1 ? "" : "S"} AT SITE</p>
        ${renderTileGroupBreakdown(siteCreditCounts, "ISSUED QTY BY GROUP")}
      </div>`;
  }

  renderAccountsTable("#ag-accounts-tbody", "#ag-accounts-empty", "#ag-accounts-table", site, false);
}

/* --- clients tab & ledger system ---------------------------- */
function renderClientsTab() {
  const site = currentSiteId() || (session && session.siteId) || "";
  const allAccounts = accountsInScope(site);
  const emptyEl = $("#clients-empty");
  const cardEl = $("#clients-ledger-card");
  const badgeEl = $("#clients-total-badge");
  const selectEl = $("#clients-select");

  if (!cardEl || !selectEl) return;

  if (allAccounts.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    cardEl.hidden = true;
    if (badgeEl) badgeEl.textContent = "0 CLIENTS";
    selectEl.innerHTML = `<option value="">NO CLIENTS IN SCOPE</option>`;
    if ($("#btn-clients-export")) $("#btn-clients-export").disabled = true;
    if ($("#btn-clients-settle")) $("#btn-clients-settle").hidden = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  cardEl.hidden = false;
  if (badgeEl) {
    badgeEl.textContent = `${allAccounts.length} CLIENT PROFILE${allAccounts.length === 1 ? "" : "S"}`;
  }

  // Ensure a valid client is selected
  if (!ui.selectedClientId || !allAccounts.some((a) => a.id === ui.selectedClientId)) {
    const withDebt = allAccounts.find((a) => accountBalance(a.id) > 0);
    ui.selectedClientId = (withDebt || allAccounts[0]).id;
  }

  // Populate client select with search filter
  const searchInput = $("#clients-search");
  const q = (searchInput ? searchInput.value : "").trim().toLowerCase();
  const list = q
    ? allAccounts.filter((a) => `${a.name} ${a.phone || ""}`.toLowerCase().includes(q))
    : allAccounts;

  selectEl.innerHTML = list.length === 0
    ? `<option value="">NO CLIENTS MATCH "${esc(q)}"</option>`
    : list.map((a) => {
        const bal = accountBalance(a.id);
        const balLabel = bal > 0 ? ` · ${money(bal)} owed` : " · settled";
        const isSel = a.id === ui.selectedClientId;
        return `<option value="${a.id}" ${isSel ? "selected" : ""}>${esc(a.name)}${a.phone ? ` (${esc(a.phone)})` : ""}${balLabel}</option>`;
      }).join("");

  if (list.length > 0 && !list.some((a) => a.id === ui.selectedClientId)) {
    ui.selectedClientId = list[0].id;
    selectEl.value = ui.selectedClientId;
  }

  renderClientLedger(ui.selectedClientId);
}

function renderClientLedger(accountId) {
  const acc = accountById(accountId);
  if (!acc) return;
  ui.selectedClientId = accountId;

  const ledger = buildAccountLedger(accountId);
  const open = ledger.openSales;
  const pays = ledger.payments;
  const balance = ledger.currentBalance;

  // Header Details
  const nameEl = $("#client-view-name");
  if (nameEl) nameEl.textContent = acc.name;

  const mergedList = typeof getMergedProfiles === "function" ? getMergedProfiles(accountId) : [];
  const metaEl = $("#client-view-meta");
  if (metaEl) {
    const mergedText = mergedList.length > 0
      ? ` · ⇄ INCLUDES MERGED: ${mergedList.map((m) => esc(m.name)).join(", ")}`
      : "";
    metaEl.innerHTML = `${esc(acc.phone || "No contact number")} · ${esc(siteName(acc.siteId))} · CLIENT REGISTERED ${fmtDate(acc.createdAt)}${mergedText}`;
  }

  const statusEl = $("#client-view-status");
  if (statusEl) {
    statusEl.innerHTML = balance > 0
      ? `<span class="chip chip-warn"><i></i>${money(balance)} OUTSTANDING</span>`
      : `<span class="chip chip-ok"><i></i>ACCOUNT SETTLED</span>`;
  }

  // KPI Tiles with Voucher Group Quantity Breakdowns
  const tilesEl = $("#client-tiles");
  if (tilesEl) {
    tilesEl.innerHTML = `
      <div class="tile">
        <p class="tile-label">TOTAL ISSUED</p>
        <p class="tile-value">${moneyCompact(ledger.totalIssued)}</p>
        <p class="tile-sub">${ledger.liveSalesCount} CREDIT VOUCHER${ledger.liveSalesCount === 1 ? "" : "S"} ISSUED</p>
        ${renderTileGroupBreakdown(ledger.issuedByType, "ISSUED QTY BY GROUP")}
      </div>
      <div class="tile">
        <p class="tile-label">SETTLED AMOUNT</p>
        <p class="tile-value">${moneyCompact(ledger.totalSettled)}</p>
        <p class="tile-sub">${pays.length} PAYMENT${pays.length === 1 ? "" : "S"} · ${ledger.settledByType.total} VOUCHER${ledger.settledByType.total === 1 ? "" : "S"} CLEARED</p>
        ${renderTileGroupBreakdown(ledger.settledByType, "SETTLED QTY BY GROUP")}
      </div>
      <div class="tile ${balance > 0 ? "tile-warn" : ""}">
        <p class="tile-label">CURRENT BALANCE</p>
        <p class="tile-value ${balance > 0 ? "owed" : "clear"}">${money(balance)}</p>
        <p class="tile-sub">${open.length} UNPAID VOUCHER${open.length === 1 ? "" : "S"}</p>
        ${renderTileGroupBreakdown(ledger.openByType, "UNPAID QTY BY GROUP")}
      </div>
      <div class="tile">
        <p class="tile-label">LEDGER ENTRIES</p>
        <p class="tile-value">${ledger.events.length}</p>
        <p class="tile-sub">${ledger.liveSalesCount} SALE${ledger.liveSalesCount === 1 ? "" : "S"} · ${pays.length} SETTLEMENT${pays.length === 1 ? "" : "S"}</p>
        ${renderTileGroupBreakdown(ledger.issuedByType, "GROUP ITEM SUMMARY")}
      </div>
    `;
  }

  // Action Buttons
  const unmergeBtn = $("#btn-clients-unmerge");
  if (unmergeBtn) {
    unmergeBtn.dataset.id = accountId;
    unmergeBtn.hidden = mergedList.length === 0;
  }
  const settleBtn = $("#btn-clients-settle");
  if (settleBtn) {
    settleBtn.dataset.id = accountId;
    settleBtn.hidden = balance <= 0;
  }
  const exportBtn = $("#btn-clients-export");
  if (exportBtn) {
    exportBtn.disabled = ledger.events.length === 0;
  }

  // Render Full Chronological Ledger
  const ledgerTbody = $("#client-ledger-tbody");
  if (ledgerTbody) {
    if (ledger.events.length === 0) {
      ledgerTbody.innerHTML = `<tr><td colspan="7" class="cell-none">NO TRANSACTIONS RECORDED ON THIS ACCOUNT</td></tr>`;
    } else {
      ledgerTbody.innerHTML = ledger.events.map((ev) => {
        const chip = ev.type === "sale" ? `<span class="chip chip-warn"><i></i>SALE</span>`
          : ev.type === "payment" ? `<span class="chip chip-ok"><i></i>SETTLEMENT</span>`
          : `<span class="chip chip-off"><i></i>REVERSAL</span>`;
        const vChip = ev.voucherType ? ` ${typeChip(ev.voucherType)}` : "";
        return `<tr>
          <td class="cell-date">${fmtDateTime(ev.date)}</td>
          <td>${chip}${vChip}</td>
          <td class="cell-code">${esc(ev.ref)}${ev.note ? `<span class="cell-sub">${esc(ev.note)}</span>` : ""}</td>
          <td class="num">${ev.debit > 0 ? `<span class="debit-amt">+${money(ev.debit)}</span>` : "—"}</td>
          <td class="num">${ev.credit > 0 ? `<span class="credit-amt">-${money(ev.credit)}</span>` : "—"}</td>
          <td class="num"><span class="balance-amt ${ev.runningBalance > 0 ? "owed-strong" : "is-zero"}">${money(ev.runningBalance)}</span></td>
          <td>${esc(ev.agent || "—")}</td>
        </tr>`;
      }).join("");
    }
  }

  // Render Breakdown View (Voucher Group Summary + Outstanding vs Settled)
  const groupSummaryHtml = `
    <div class="group-summary-box">
      <h4 class="mini-head" style="margin-top:0">VOUCHER GROUP QUANTITY BREAKDOWN</h4>
      <table class="grid-table">
        <thead>
          <tr>
            <th>VOUCHER GROUP</th>
            <th class="num">ISSUED QTY</th>
            <th class="num">SETTLED QTY</th>
            <th class="num">UNPAID QTY</th>
            <th class="num">BALANCE OWED</th>
          </tr>
        </thead>
        <tbody>
          ${TYPE_ORDER.map((t) => {
            const g = (ledger.byTypeSummary && ledger.byTypeSummary[t]) || { issuedCount: 0, settledCount: 0, openCount: 0, openAmt: 0 };
            return `<tr>
              <td>${typeChip(t)}</td>
              <td class="num mono">${g.issuedCount}</td>
              <td class="num mono">${g.settledCount}</td>
              <td class="num mono ${g.openCount > 0 ? "owed-strong" : ""}">${g.openCount}</td>
              <td class="num ${g.openAmt > 0 ? "owed-strong" : "dim"}">${money(g.openAmt)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  $("#client-open").innerHTML = groupSummaryHtml + (open.length === 0
    ? `<p class="hint" style="margin-top:12px">No unpaid vouchers — this account is clear.</p>`
    : `<h4 class="mini-head">UNPAID VOUCHERS (${formatGroupQtyInline(ledger.openByType)})</h4>` +
      `<table class="grid-table"><thead><tr><th>DATE</th><th>VOUCHER</th><th>TYPE</th><th class="num">OWED</th></tr></thead><tbody>` +
      open.map((s) => `<tr>
        <td class="cell-date">${fmtDateTime(s.soldAt)}</td>
        <td class="cell-code">${esc(s.voucherCode)}</td>
        <td>${typeChip(s.type)}</td>
        <td class="num owed-strong">${money(saleOutstanding(s))}</td>
      </tr>`).join("") + `</tbody></table>`);

  const clearedBy = (p) => (p.allocations || []).map((a) => {
    const sale = db.sales.find((x) => x.id === a.saleId);
    if (!sale) return null;
    const part = a.amount < sale.price ? ` (${money(a.amount)} of ${money(sale.price)})` : "";
    return `${sale.voucherCode} [${(VTYPES[sale.type] && VTYPES[sale.type].label) || sale.type}]${part} · ${fmtDate(sale.soldAt)}`;
  }).filter(Boolean);

  $("#client-pays").innerHTML = pays.length === 0
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
}

function switchClientLedgerTab(tabKey) {
  const ledgerView = $("#client-ledger-view");
  const breakdownView = $("#client-breakdown-view");
  const tabLedger = $("#client-tab-btn-ledger");
  const tabBreakdown = $("#client-tab-btn-breakdown");

  if (tabKey === "breakdown") {
    if (ledgerView) ledgerView.hidden = true;
    if (breakdownView) breakdownView.hidden = false;
    if (tabLedger) tabLedger.classList.remove("is-active");
    if (tabBreakdown) tabBreakdown.classList.add("is-active");
  } else {
    if (ledgerView) ledgerView.hidden = false;
    if (breakdownView) breakdownView.hidden = true;
    if (tabLedger) tabLedger.classList.add("is-active");
    if (tabBreakdown) tabBreakdown.classList.remove("is-active");
  }
}

function openClientLedger(accountId) {
  ui.selectedClientId = accountId;
  setTab("clients");
  renderClientsTab();
}
const openStatement = openClientLedger;
const switchStatementTab = switchClientLedgerTab;

function exportClientLedgerCSV() {
  const accountId = ui.selectedClientId;
  const ledger = accountId ? buildAccountLedger(accountId) : null;
  if (!ledger || !ledger.events.length) return toast("No ledger entries to export", "err");
  const head = ["Date", "Transaction Type", "Reference", "Note", "Debit (+)", "Credit (-)", "Running Balance", "Agent"];
  const rows = ledger.events.map((ev) => [
    new Date(ev.date).toISOString(),
    ev.typeLabel || ev.type.toUpperCase(),
    ev.ref,
    ev.note || "",
    ev.debit > 0 ? ev.debit : 0,
    ev.credit > 0 ? ev.credit : 0,
    ev.runningBalance,
    ev.agent || "",
  ]);
  const safeName = (ledger.account.name || "client").toLowerCase().replace(/[^a-z0-9]/g, "-");
  downloadCSV(`ledger-${safeName}-${dayKey(new Date())}.csv`, [head].concat(rows));
  toast(`Exported transaction ledger for ${ledger.account.name}`);
}
const exportStatementLedgerCSV = exportClientLedgerCSV;

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

  const myPeriodSales = db.sales.filter((s) => s.agentId === user.id && inSite(s, site) && inPeriod(s.soldAt, period) && !isReversed(s));
  const myCashCounts = countByVoucherGroup(myPeriodSales.filter((s) => s.pay === "cash"));
  const myCreditCounts = countByVoucherGroup(myPeriodSales.filter((s) => s.pay === "credit"));
  const myTotalCounts = {
    V5: (r.byType && r.byType.V5 ? r.byType.V5.count : myCashCounts.V5 + myCreditCounts.V5),
    V10: (r.byType && r.byType.V10 ? r.byType.V10.count : myCashCounts.V10 + myCreditCounts.V10),
    REC: (r.byType && r.byType.REC ? r.byType.REC.count : myCashCounts.REC + myCreditCounts.REC),
  };

  $("#me-status").innerHTML = closed
    ? `<span class="chip chip-ok"><i></i>CLOSED ${fmtDateTime(closed.generatedAt)}</span>`
    : `<span class="chip chip-off"><i></i>OPEN PERIOD</span>`;

  $("#me-tiles").innerHTML = `
    <div class="tile tile-hero">
      <p class="tile-label">TOTAL CASH COLLECTED</p>
      <p class="tile-value">${money(r.totalCashCollected)}</p>
      <p class="tile-sub">SALES ${money(r.cashSalesTotal)} · SETTLEMENTS ${money(r.debtCollected)}</p>
      ${renderTileGroupBreakdown(myCashCounts, "CASH SALES QTY BY GROUP")}
    </div>
    <div class="tile tile-warn">
      <p class="tile-label">OUTSTANDING DEBT</p>
      <p class="tile-value">${money(r.unpaidFromPeriod)}</p>
      <p class="tile-sub">FROM ${money(r.creditIssued)} ISSUED ON CREDIT</p>
      ${renderTileGroupBreakdown(myCreditCounts, "CREDIT QTY BY GROUP")}
    </div>
    <div class="tile">
      <p class="tile-label">TRANSACTIONS</p>
      <p class="tile-value">${r.salesCount}</p>
      <p class="tile-sub">${r.cashCount} CASH · ${r.creditCount} CREDIT</p>
      ${renderTileGroupBreakdown(myTotalCounts, "TOTAL QTY BY GROUP")}
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

/* ------------------------------------------------------------
   Cash hand-over

   The statement above says what was collected. This says how much of it
   has actually been handed in — the number the shop cares about and the
   one it never had. Closing a month freezes what was collected; it does
   not mean the money arrived, so a closed month keeps owing until it is
   handed over, and says so here.
   ------------------------------------------------------------ */
function renderCashout() {
  const user = currentUser();
  if (!user) return;
  const site = terminalSiteId();
  const period = $("#me-period").value || monthKey(new Date());
  const pos = cashPosition(user.id, period, site);

  // Earlier months still owing. Shown whether or not they are closed —
  // a closed month with cash outstanding is exactly the case that used to
  // vanish, because closing looked like finishing.
  const brought = openCashPeriods(user.id, site).filter((p) => p.period < period);
  const broughtTotal = brought.reduce((s, p) => s + p.outstanding, 0);

  $("#co-status").innerHTML = pos.outstanding > 0
    ? `<span class="chip chip-sold"><i></i>${money(pos.outstanding)} STILL TO HAND IN</span>`
    : pos.due > 0
      ? `<span class="chip chip-ok"><i></i>SETTLED IN FULL</span>`
      : `<span class="chip chip-off"><i></i>NOTHING COLLECTED</span>`;

  $("#co-brought").innerHTML = `
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>${esc(fmtMonth(period))}</th><th class="num">AMOUNT</th></tr></thead>
      <tbody>
        <tr><td>Cash collected${pos.closed ? ` <span class="cell-sub">frozen at close</span>` : ""}</td><td class="num">${money(pos.due)}</td></tr>
        <tr><td>Handed over</td><td class="num">${money(pos.handedOver)}</td></tr>
        <tr class="row-total"><td>Still in your hands</td><td class="num ${pos.outstanding > 0 ? "owed-strong" : "strong"}">${money(pos.outstanding)}</td></tr>
      </tbody>
    </table></div>` +
    (brought.length ? `
    <h3 class="mini-head">BROUGHT FORWARD — EARLIER MONTHS STILL OWING</h3>
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>MONTH</th><th class="num">COLLECTED</th><th class="num">HANDED OVER</th><th class="num">STILL OWING</th><th>STATUS</th></tr></thead>
      <tbody>${brought.map((p) => `
        <tr>
          <td>${esc(fmtMonth(p.period))}</td>
          <td class="num">${money(p.due)}</td>
          <td class="num">${money(p.handedOver)}</td>
          <td class="num owed-strong">${money(p.outstanding)}</td>
          <td>${p.closed ? `<span class="chip chip-ok"><i></i>CLOSED</span>` : `<span class="chip chip-off"><i></i>OPEN</span>`}</td>
        </tr>`).join("")}
        <tr class="row-total"><td>Total brought forward</td><td class="num">—</td><td class="num">—</td><td class="num owed-strong">${money(broughtTotal)}</td><td></td></tr>
      </tbody>
    </table></div>` : "");

  const live = cashoutsFor(user.id, period, site)
    .slice().sort((a, b) => (a.handedOverAt < b.handedOverAt ? 1 : -1));
  const voided = db.cashouts.filter((c) =>
    c.userId === user.id && c.period === period
    && (!site || (c.siteId || "") === site) && c.voidedAt);

  $("#co-history").innerHTML = `
    <h3 class="mini-head">HAND-OVERS FOR ${esc(fmtMonth(period))}</h3>` +
    (live.length + voided.length === 0
      ? `<p class="hint">Nothing handed over for this month yet.</p>`
      : `<div class="table-wrap"><table class="grid-table">
      <thead><tr><th>WHEN</th><th class="num">AMOUNT</th><th>METHOD</th><th>REFERENCE</th><th>RECORDED BY</th></tr></thead>
      <tbody>${[...live, ...voided].map((c) => `
        <tr class="${c.voidedAt ? "row-reversed" : ""}">
          <td class="cell-date">${fmtDateTime(c.handedOverAt)}</td>
          <td class="num">${money(c.amount)}</td>
          <td>${esc(PAY_METHODS[c.method] || c.method)}</td>
          <td>${esc(c.reference || "—")}</td>
          <td>${esc(c.recordedByName)}${c.recordedByRole === "admin" ? `<span class="cell-sub">received by an administrator</span>` : ""}
            ${c.voidedAt ? `<span class="rev-note">VOIDED — ${esc(c.voidReason || "")}</span>` : ""}</td>
        </tr>`).join("")}
      </tbody></table></div>`);

  $("#btn-cashout").disabled = !site;
  $("#btn-cashout").title = site ? "" : "Choose a single site first — cash is accounted for per site";
}

// The month defaults to the oldest one still owing, not the one on screen.
// Paying against this month while an older one is short is how a shortfall
// gets buried, and the agent is rarely the one who notices.
function openCashout() {
  const user = currentUser();
  const site = terminalSiteId();
  if (!site) return toast("Choose a single site first — cash is accounted for per site", "err");

  const shown = $("#me-period").value || monthKey(new Date());
  const open = openCashPeriods(user.id, site);
  const choices = [...new Set([...open.map((p) => p.period), shown])].sort();

  $("#cashout-who").textContent = user.name;
  $("#cashout-meta").textContent = ` · ${user.code} · ${siteName(site)}`;
  $("#cashout-period").innerHTML = choices.map((p) => {
    const pos = cashPosition(user.id, p, site);
    return `<option value="${p}">${esc(fmtMonth(p))} — ${money(pos.outstanding)} owing</option>`;
  }).join("");
  $("#cashout-period").value = open.length ? open[0].period : shown;

  $("#cashout-amount").value = "";
  $("#cashout-ref").value = "";
  $("#cashout-method").value = "cash";
  $("#cashout-err").hidden = true;
  syncCashoutOwed();
  $("#modal-cashout").hidden = false;
  setTimeout(() => $("#cashout-amount").focus(), 40);
}

// Whose money the open modal is about. An agent hands in their own; an
// administrator receiving cash sets ui.cashoutFor and the same modal serves.
function cashoutTarget() {
  const on = ui.cashoutFor;
  if (on) return { userId: on.userId, siteId: on.siteId, onBehalf: true };
  const me = currentUser();
  return { userId: me ? me.id : "", siteId: terminalSiteId(), onBehalf: false };
}

function syncCashoutOwed() {
  const { userId, siteId: site } = cashoutTarget();
  const period = $("#cashout-period").value;
  if (!userId || !period) return;
  const pos = cashPosition(userId, period, site);
  $("#cashout-owed").innerHTML = pos.outstanding > 0
    ? `<b>${money(pos.outstanding)}</b> still to hand in for ${esc(fmtMonth(period))} <span class="dim">— ${money(pos.due)} collected, ${money(pos.handedOver)} already in</span>`
    : `<span class="dim">${esc(fmtMonth(period))} is settled — ${money(pos.due)} collected, ${money(pos.handedOver)} handed in.</span>`;
  $("#cashout-owed").dataset.owed = String(Math.max(0, pos.outstanding));
}

async function submitCashout() {
  const { userId, siteId: site, onBehalf } = cashoutTarget();
  const me = currentUser();
  const period = $("#cashout-period").value;
  const amount = Number($("#cashout-amount").value);
  const fail = (msg) => {
    const err = $("#cashout-err");
    err.textContent = msg; err.hidden = false;
  };
  if (!site) return fail("Choose a single site first.");
  if (!period) return fail("Pick the month this cash covers.");
  if (!(amount > 0)) return fail("Enter the amount handed over.");

  const pos = cashPosition(userId, period, site);
  // Handing in more than the month is short is a counting mistake, not
  // generosity: it leaves a negative balance nothing in the ledger explains.
  if (amount > pos.outstanding + 0.001) {
    return fail(`That is more than ${fmtMonth(period)} is short — ${money(pos.outstanding)} is outstanding.`);
  }

  const btn = $("#cashout-confirm");
  btn.disabled = true;
  try {
    const rec = recordCashout({
      forUserId: userId, siteId: site, period, amount,
      method: $("#cashout-method").value,
      reference: $("#cashout-ref").value,
      byUserId: me.id,
    });
    if (!rec) return fail("Enter the amount handed over.");
    ui.cashoutFor = null;
    $("#modal-cashout").hidden = true;
    renderAll();
    const left = cashPosition(userId, period, site).outstanding;
    const who = onBehalf ? `${(userById(userId) || {}).name || "the agent"} — ` : "";
    toast(left > 0
      ? `${who}${money(amount)} recorded for ${fmtMonth(period)}, ${money(left)} still to hand in`
      : `${who}${money(amount)} recorded — ${fmtMonth(period)} is settled in full`);
  } catch (e) {
    fail(cloudError(e));
  } finally {
    btn.disabled = false;
  }
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

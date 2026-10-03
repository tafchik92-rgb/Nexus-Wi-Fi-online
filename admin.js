/* ============================================================
   NEXUS//POS — admin workspace
   Dashboard · Team · Vouchers · Sites · Credit · Reports
   ============================================================ */
"use strict";

/* ------------------------------------------------------------
   Dashboard
   ------------------------------------------------------------ */
function renderTiles() {
  const site = currentSiteId();
  // Totals count only sales that still stand; reversed ones are history.
  const sales = liveSales(site);
  const cash = sales.filter((s) => s.pay === "cash").reduce((sum, s) => sum + s.price, 0);
  const creditIssued = sales.filter((s) => s.pay === "credit").reduce((sum, s) => sum + s.price, 0);
  const collected = db.payments
    .filter((p) => !site || (accountById(p.accountId) || {}).siteId === site)
    .reduce((sum, p) => sum + p.amount, 0);
  const owed = totalOutstanding(site);

  const today = dayKey(new Date());
  const yest = dayKey(Date.now() - 864e5);
  const todayCount = sales.filter((s) => dayKey(s.soldAt) === today).length;
  const yestCount = sales.filter((s) => dayKey(s.soldAt) === yest).length;
  const diff = todayCount - yestCount;
  const delta = (yestCount > 0 || todayCount > 0)
    ? `<span class="tile-delta ${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}</span> vs yesterday`
    : "no activity yet";

  const stockTotal = TYPE_ORDER.reduce((sum, t) => sum + stockOf(t, site), 0);
  const debtors = openAccounts(site).length;

  $("#stat-tiles").innerHTML = `
    <div class="tile">
      <p class="tile-label">CASH COLLECTED</p>
      <p class="tile-value">${moneyCompact(cash + collected)}</p>
      <p class="tile-sub">SALES ${money(cash)} · SETTLEMENTS ${money(collected)}</p>
    </div>
    <div class="tile tile-warn">
      <p class="tile-label">OUTSTANDING DEBT</p>
      <p class="tile-value">${moneyCompact(owed)}</p>
      <p class="tile-sub">${debtors} OPEN ACCOUNT${debtors === 1 ? "" : "S"} · ${money(creditIssued)} ISSUED</p>
    </div>
    <div class="tile">
      <p class="tile-label">SALES TODAY</p>
      <p class="tile-value">${todayCount}</p>
      <p class="tile-sub">${delta}</p>
    </div>
    <div class="tile">
      <p class="tile-label">VOUCHERS IN STOCK</p>
      <p class="tile-value">${stockTotal}</p>
      <p class="tile-sub">$5×${stockOf("V5", site)} · $10×${stockOf("V10", site)} · REC×${stockOf("REC", site)}</p>
    </div>`;
}

/* --- 7-day revenue chart (cash vs settlements, stacked) ------- */
function last7Days(siteId) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    days.push({
      key: dayKey(d),
      label: d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
      cash: 0, settle: 0, credit: 0, count: 0,
    });
  }
  const idx = Object.fromEntries(days.map((d, i) => [d.key, i]));
  for (const s of liveSales(siteId)) {
    const i = idx[dayKey(s.soldAt)];
    if (i === undefined) continue;
    days[i].count++;
    if (s.pay === "cash") days[i].cash += s.price; else days[i].credit += s.price;
  }
  for (const p of db.payments) {
    if (siteId && (accountById(p.accountId) || {}).siteId !== siteId) continue;
    const i = idx[dayKey(p.receivedAt)];
    if (i !== undefined) days[i].settle += p.amount;
  }
  return days;
}

function niceStep(raw) {
  raw = Math.max(raw, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 3, 4, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function renderChart() {
  const wrap = $("#rev-chart");
  const site = currentSiteId();
  const days = last7Days(site);
  const week = days.reduce((s, d) => s + d.cash + d.settle, 0);
  $("#chart-note").textContent = week > 0 ? `${money(week)} CASH IN THIS WEEK` : "";

  if (db.sales.length === 0) {
    wrap.innerHTML = `<div class="empty"><p class="empty-title">AWAITING SIGNAL</p>
      <p class="empty-sub">Cash flow plots here as sales and settlements come in.</p></div>`;
    return;
  }

  const W = 760, H = 240, padL = 54, padR = 14, padT = 22, padB = 44;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const totals = days.map((d) => d.cash + d.settle);
  const step = niceStep(Math.max(1, Math.max(...totals, 1) / 4));
  const max = step * 4;
  const band = plotW / 7;
  const barW = Math.min(24, band * 0.55);
  const y = (v) => padT + plotH * (1 - v / max);
  const peak = Math.max(...totals);

  let g = "";
  for (let i = 1; i <= 4; i++) {
    const v = step * i, yy = y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" style="stroke:var(--chart-grid);stroke-width:1"/>`;
    g += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" style="font-size:11px;fill:var(--ink-3);font-family:var(--font-mono)">$${v.toLocaleString()}</text>`;
  }
  g += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" style="stroke:var(--chart-axis);stroke-width:1"/>`;

  days.forEach((d, i) => {
    const cx = padL + band * i + band / 2;
    const x0 = cx - barW / 2;
    const total = d.cash + d.settle;
    if (total > 0) {
      // stacked: sales cash (bottom) + debt settlements (top), 2px surface gap between
      const yTop = y(total);
      const r = Math.min(4, (total / max) * plotH);
      const settleH = (d.settle / max) * plotH;
      const cashTop = d.settle > 0 ? yTop + settleH + 2 : yTop;
      if (d.settle > 0) {
        g += `<path d="M ${x0} ${yTop + settleH} L ${x0} ${yTop + r} Q ${x0} ${yTop} ${x0 + r} ${yTop} L ${x0 + barW - r} ${yTop} Q ${x0 + barW} ${yTop} ${x0 + barW} ${yTop + r} L ${x0 + barW} ${yTop + settleH} Z"
               style="fill:var(--chart-magenta)" class="bar" data-i="${i}"/>`;
        g += `<rect x="${x0}" y="${cashTop}" width="${barW}" height="${Math.max(0, y(0) - cashTop)}" style="fill:var(--chart-cyan)" class="bar" data-i="${i}"/>`;
      } else {
        g += `<path d="M ${x0} ${y(0)} L ${x0} ${yTop + r} Q ${x0} ${yTop} ${x0 + r} ${yTop} L ${x0 + barW - r} ${yTop} Q ${x0 + barW} ${yTop} ${x0 + barW} ${yTop + r} L ${x0 + barW} ${y(0)} Z"
               style="fill:var(--chart-cyan)" class="bar" data-i="${i}"/>`;
      }
      if (total === peak) {
        g += `<text x="${cx}" y="${yTop - 7}" text-anchor="middle" style="font-size:11.5px;font-weight:700;fill:var(--ink-2);font-family:var(--font-ui)">${money(total)}</text>`;
      }
    }
    g += `<text x="${cx}" y="${H - 23}" text-anchor="middle" style="font-size:10.5px;letter-spacing:1.5px;fill:var(--ink-3);font-family:var(--font-ui)">${d.label}</text>`;
    g += `<rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" fill="transparent" class="hit" data-i="${i}" style="cursor:crosshair"/>`;
  });

  // legend — identity never rides on color alone
  g += `<g transform="translate(${padL},${H - 8})">
      <rect x="0" y="-9" width="10" height="10" rx="2" style="fill:var(--chart-cyan)"/>
      <text x="16" y="0" style="font-size:10.5px;fill:var(--ink-2);font-family:var(--font-ui);letter-spacing:1px">SALES CASH</text>
      <rect x="118" y="-9" width="10" height="10" rx="2" style="fill:var(--chart-magenta)"/>
      <text x="134" y="0" style="font-size:10.5px;fill:var(--ink-2);font-family:var(--font-ui);letter-spacing:1px">DEBT SETTLED</text>
    </g>`;

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cash collected over the last 7 days, split between sales cash and debt settlements">${g}</svg>`;

  const tip = $("#chart-tip");
  $$(".hit", wrap).forEach((hit) => {
    hit.addEventListener("mousemove", (e) => {
      const d = days[+hit.dataset.i];
      tip.innerHTML = `${d.label} <span class="tip-dim">·</span> cash ${money(d.cash)} <span class="tip-dim">·</span> settled ${money(d.settle)}` +
        (d.credit > 0 ? ` <span class="tip-dim">· credit issued ${money(d.credit)}</span>` : "");
      tip.hidden = false;
      let tx = e.clientX + 14;
      if (tx + tip.offsetWidth > window.innerWidth - 8) tx = e.clientX - tip.offsetWidth - 14;
      tip.style.left = tx + "px";
      tip.style.top = Math.max(8, e.clientY - 36) + "px";
      $$(".bar", wrap).forEach((b) => (b.style.opacity = b.dataset.i === hit.dataset.i ? "1" : "0.45"));
    });
    hit.addEventListener("mouseleave", () => {
      tip.hidden = true;
      $$(".bar", wrap).forEach((b) => (b.style.opacity = "1"));
    });
  });
}

/* --- sales ledger -------------------------------------------- */
function filteredSales() {
  const { q, type, pay, range } = ui.filters;
  const needle = q.trim().toLowerCase();
  const today = dayKey(new Date());
  const cutoff7 = Date.now() - 7 * 864e5;
  return salesInScope(currentSiteId())
    .filter((s) => {
      if (type !== "all" && s.type !== type) return false;
      if (pay !== "all" && s.pay !== pay) return false;
      if (range === "today" && dayKey(s.soldAt) !== today) return false;
      if (range === "7d" && new Date(s.soldAt).getTime() < cutoff7) return false;
      if (needle) {
        const hay = `${s.customer} ${s.phone} ${s.voucherCode} ${s.agentName}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => b.soldAt.localeCompare(a.soldAt));
}

function renderSales() {
  const rows = filteredSales();
  const all = salesInScope(currentSiteId());
  $("#sales-empty").hidden = all.length !== 0;
  $("#sales-table").style.display = all.length === 0 ? "none" : "";

  // A reversed sale stays in the ledger, struck through and labelled. Hiding
  // it would leave a voucher back in stock with nothing to account for it.
  $("#sales-tbody").innerHTML = rows.map((s) => {
    const owed = saleOutstanding(s);
    const rev = reversalOf(s.id);
    return `<tr class="${rev ? "row-reversed" : ""}">
      <td class="cell-date">${fmtDateTime(s.soldAt)}</td>
      <td>${esc(s.customer)}${s.phone ? `<span class="cell-sub mono">${esc(s.phone)}</span>` : ""}</td>
      <td class="cell-code">${esc(s.voucherCode)}</td>
      <td>${typeChip(s.type)}</td>
      <td class="num">${s.price > 0 ? money(s.price) : "—"}</td>
      <td>${rev
        ? `<span class="chip chip-sold"><i></i>REVERSED</span><span class="cell-sub">${esc(rev.reason || "no reason given")}</span>`
        : payChip(s.pay) + (owed > 0 ? `<span class="cell-sub owed">OWES ${money(owed)}</span>` : "")}</td>
      <td>${esc(s.agentName)}<span class="cell-sub">${esc(siteName(s.siteId))}</span></td>
      <td>${rev
        ? `<span class="cell-sub">${esc(rev.reversedByName || "")} · ${fmtDate(rev.reversedAt)}</span>`
        : `<button class="row-act danger" data-action="reverse-sale" data-id="${s.id}">REVERSE</button>`}</td>
    </tr>`;
  }).join("") || (all.length > 0
    ? `<tr><td colspan="8" class="cell-none">NO RECORDS MATCH THE CURRENT FILTERS</td></tr>` : "");
}

/* --- reversing a sale ----------------------------------------
   The fault this answers: a network wobble mid-sale that bills a customer
   twice. The duplicate has to come off the books and its code has to go
   somewhere sensible — back into stock if nobody received it, or out of
   circulation if they did and it must never be sold again. */
function openReversal(saleId) {
  const sale = db.sales.find((s) => s.id === saleId);
  if (!sale) return;
  if (reversalOf(saleId)) return toast("That sale has already been reversed", "err");
  if (!isAdmin()) return toast("Administrators only", "err");

  ui.reverseSale = saleId;
  const paid = paidMap().get(sale.id) || 0;
  const closed = db.closings.find((c) =>
    c.userId === sale.agentId && c.period === monthKey(sale.soldAt) && (c.siteId || "") === (sale.siteId || ""));

  $("#rev-title").textContent = sale.voucherCode;
  $("#rev-details").innerHTML = `
    <div><dt>CUSTOMER</dt><dd>${esc(sale.customer)}</dd></div>
    <div><dt>PACKAGE</dt><dd>${VTYPES[sale.type].label}</dd></div>
    <div><dt>CHARGED</dt><dd>${sale.price > 0 ? money(sale.price) : "$0"} ${sale.pay.toUpperCase()}</dd></div>
    <div><dt>SOLD BY</dt><dd>${esc(sale.agentName)} · ${fmtDateTime(sale.soldAt)}</dd></div>
    <div><dt>SITE</dt><dd>${esc(siteName(sale.siteId))}</dd></div>`;

  // Two things the operator cannot see from the row but must know before
  // cancelling: money already taken, and a month already closed.
  const notes = [];
  if (paid > 0) {
    notes.push(`<b>${money(paid)} has already been collected</b> against this sale. Reversing clears the debt but does not refund it — hand the cash back, or leave it on the account.`);
  }
  if (closed) {
    notes.push(`${esc(sale.agentName)} has already <b>closed ${fmtMonth(monthKey(sale.soldAt))}</b>. Those totals are frozen and will not change; only live figures will.`);
  }
  $("#rev-notes").innerHTML = notes.map((n) => `<p class="rev-note">⚠ ${n}</p>`).join("");
  $("#rev-notes").hidden = notes.length === 0;

  $("#rev-reason").value = "";
  $$("#rev-outcome .seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.outcome === "restocked"));
  ui.reverseOutcome = "restocked";
  $("#modal-reverse").hidden = false;
  setTimeout(() => $("#rev-reason").focus(), 40);
}

async function submitReversal() {
  const sale = db.sales.find((s) => s.id === ui.reverseSale);
  if (!sale) return;
  const reason = $("#rev-reason").value.trim();
  if (!reason) return toast("Say why this sale is being reversed — it goes on the record", "err");

  const btn = $("#rev-confirm");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "◈ REVERSING…";
  try {
    const rec = await Backend.reverseSale(sale, {
      outcome: ui.reverseOutcome,
      reason,
      paidSoFar: paidMap().get(sale.id) || 0,
    });
    db.reversals.push(rec);
    const v = db.vouchers.find((x) => x.id === sale.voucherId);
    if (v) v.status = ui.reverseOutcome === "restocked" ? "available" : "void";
    save(); renderAll();
    $("#modal-reverse").hidden = true;
    toast(ui.reverseOutcome === "restocked"
      ? `Sale reversed — ${sale.voucherCode} is back in stock`
      : `Sale reversed — ${sale.voucherCode} is void and cannot be sold again`);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === "NO_CONNECTION") {
      toast("No connection to the shop — nothing was reversed. Try again when the link is back.", "err");
    } else if (msg === "ALREADY_REVERSED") {
      toast("That sale was already reversed", "err");
    } else {
      toast(cloudError(e), "err");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function exportSalesCSV() {
  const rows = filteredSales();
  if (rows.length === 0) return toast("Nothing to export with the current filters", "err");
  const head = ["Date", "Site", "Customer", "Phone", "Voucher", "Type", "Price", "Payment",
    "Outstanding", "Agent", "Status", "Reversed by", "Reversal reason"];
  downloadCSV(`nexus-pos-sales-${dayKey(new Date())}.csv`, [head].concat(rows.map((s) => {
    const rev = reversalOf(s.id);
    return [
      new Date(s.soldAt).toISOString(), siteName(s.siteId), s.customer, s.phone, s.voucherCode,
      VTYPES[s.type].label, s.price, s.pay.toUpperCase(), saleOutstanding(s), s.agentName,
      rev ? "REVERSED" : "", rev ? rev.reversedByName : "", rev ? rev.reason : "",
    ];
  })));
  toast(`Exported ${rows.length} record${rows.length === 1 ? "" : "s"} to CSV`);
}

/* ------------------------------------------------------------
   Team (users)
   ------------------------------------------------------------ */
function renderTeam() {
  $("#team-empty").hidden = db.users.length !== 0;
  $("#team-table").style.display = db.users.length === 0 ? "none" : "";
  $("#team-note").textContent = db.users.length
    ? `${db.users.filter((u) => u.status === "active").length} ACTIVE / ${db.users.length} TOTAL` : "";

  $("#team-tbody").innerHTML = db.users.map((u) => {
    const sales = db.sales.filter((s) => s.agentId === u.id && !isReversed(s));
    const rev = sales.reduce((sum, s) => sum + s.price, 0);
    const sites = (u.role === "admin") ? "ALL SITES"
      : (u.siteIds || []).map(siteName).join(", ") || "—";
    const me = session && u.id === session.userId;
    return `<tr>
      <td>${esc(u.name)}${me ? ` <span class="tag-you">YOU</span>` : ""}</td>
      <td class="cell-code">${esc(u.code)}</td>
      <td>${roleChip(u.role)}</td>
      <td class="cell-sites">${esc(sites)}</td>
      <td>${statusChip(u.status)}${!u.pinHash ? `<span class="cell-sub nopin">NO PIN — RESET TO ENABLE</span>` : ""}</td>
      <td class="num">${sales.length}</td>
      <td class="num">${money(rev)}</td>
      <td class="row-acts">
        <button class="row-act" data-action="reset-pin" data-id="${u.id}">RESET PIN</button>
        ${me ? "" : `<button class="row-act" data-action="toggle-user" data-id="${u.id}">${u.status === "active" ? "SUSPEND" : "ACTIVATE"}</button>`}
        ${(!me && sales.length === 0) ? `<button class="row-act danger" data-action="del-user" data-id="${u.id}">DELETE</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  // site checkboxes on the new-user form
  $("#u-sites").innerHTML = db.sites.map((s) => `
    <label class="check"><input type="checkbox" value="${s.id}" /> ${esc(s.name)}</label>`).join("")
    || `<p class="hint">Create a site first — agents must be assigned to one.</p>`;
}

async function addUser(form) {
  const name = $("#u-name").value.trim();
  const code = $("#u-code").value.trim().toUpperCase();
  const role = $("#u-role").value;
  const pin = $("#u-pin").value.trim();
  const siteIds = $$("#u-sites input:checked").map((c) => c.value);

  if (!name || !code) return toast("Name and staff code are required", "err");
  if (!/^\d{4,8}$/.test(pin)) return toast("PIN must be 4–8 digits", "err");
  if (db.users.some((u) => u.code === code)) return toast(`Code ${code} is already assigned`, "err");
  if (role === "agent" && siteIds.length === 0) return toast("Assign the agent to at least one site", "err");

  // The server owns credentials: it hashes the PIN and mints the record.
  try {
    await Backend.call("createStaff", { name, code, role, pin, siteIds });
  } catch (e) { return toast(cloudError(e), "err"); }
  form.reset(); renderAll();
  toast(`${role === "admin" ? "Administrator" : "Agent"} ${name} added as ${code}`);
}

/* ------------------------------------------------------------
   Sites
   ------------------------------------------------------------ */
function renderSites() {
  $("#sites-empty").hidden = db.sites.length !== 0;
  $("#sites-table").style.display = db.sites.length === 0 ? "none" : "";

  $("#sites-tbody").innerHTML = db.sites.map((s) => {
    const sales = db.sales.filter((x) => x.siteId === s.id && !isReversed(x));
    const rev = sales.reduce((sum, x) => sum + x.price, 0);
    const stock = TYPE_ORDER.reduce((sum, t) => sum + stockOf(t, s.id), 0);
    const staff = db.users.filter((u) => (u.siteIds || []).includes(s.id)).length;
    const canDelete = sales.length === 0 && db.vouchers.every((v) => v.siteId !== s.id);
    return `<tr>
      <td>${esc(s.name)}</td>
      <td class="cell-code">${esc(s.code)}</td>
      <td>${statusChip(s.status)}</td>
      <td class="num">${staff}</td>
      <td class="num">${stock}</td>
      <td class="num">${sales.length}</td>
      <td class="num">${money(rev)}</td>
      <td class="num">${money(totalOutstanding(s.id))}</td>
      <td class="row-acts">
        <button class="row-act accent" data-action="edit-site" data-id="${s.id}">RENAME</button>
        <button class="row-act" data-action="toggle-site" data-id="${s.id}">${s.status === "active" ? "CLOSE" : "REOPEN"}</button>
        ${canDelete ? `<button class="row-act danger" data-action="del-site" data-id="${s.id}">DELETE</button>` : ""}
      </td>
    </tr>`;
  }).join("");
}

function addSite(form) {
  const name = $("#s-name").value.trim();
  const code = $("#s-code").value.trim().toUpperCase();
  if (!name || !code) return toast("Site name and code are required", "err");
  if (db.sites.some((s) => s.code === code)) return toast(`Site code ${code} already exists`, "err");
  const site = { id: newId(), name, code, status: "active", createdAt: new Date().toISOString() };
  db.sites.push(site);
  touch("sites", site);
  save(); renderAll();
  form.reset();
  toast(`Site ${name} (${code}) opened`);
}

/* ------------------------------------------------------------
   Vouchers
   ------------------------------------------------------------ */
function uploadSiteId() {
  const el = $("#up-site");
  return el ? el.value : "";
}

function renderStockCards() {
  const site = currentSiteId();
  $("#stock-cards").innerHTML = TYPE_ORDER.map((t) => {
    const conf = VTYPES[t];
    const avail = stockOf(t, site), sold = soldOf(t, site), total = avail + sold;
    const pct = total === 0 ? 0 : Math.round((avail / total) * 100);
    const fill = { V5: "var(--chart-cyan)", V10: "var(--chart-amber)", REC: "var(--chart-magenta)" }[t];
    return `<div class="stock-card">
      <div class="stock-head">
        <span class="stock-name">${conf.label}</span>
        <span class="stock-price">${conf.price > 0 ? money(conf.price) + " / UNIT" : "NO CHARGE"}</span>
      </div>
      <div class="stock-nums">
        <span class="stock-avail">${avail}</span>
        <span class="stock-of">AVAILABLE · ${sold} SOLD · ${total} LOADED</span>
      </div>
      <div class="meter" role="img" aria-label="${pct}% of ${conf.label} stock remaining">
        <div class="meter-fill" style="width:${pct}%;background:${fill}"></div>
      </div>
    </div>`;
  }).join("");
}

function renderVoucherSiteSelect() {
  const sel = $("#up-site");
  const prev = sel.value;
  const sites = activeSites();
  sel.innerHTML = sites.map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.code)}</option>`).join("")
    || `<option value="">— NO ACTIVE SITE —</option>`;
  const scoped = currentSiteId();
  sel.value = (prev && sites.some((s) => s.id === prev)) ? prev
    : (scoped && sites.some((s) => s.id === scoped)) ? scoped
    : (sites[0] ? sites[0].id : "");
}

// The rows the vault is currently showing — also exactly what a bulk purge
// acts on, so the operator can always see what they are about to delete.
function filteredVouchers() {
  const { type, status, batch } = ui.vfilters;
  const site = currentSiteId();
  return db.vouchers
    .filter((v) => inSite(v, site))
    .filter((v) => (type === "all" || v.type === type)
                && (status === "all" || v.status === status)
                && (!batch || batch === "all" || v.batch === batch))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.code.localeCompare(b.code));
}

function renderVouchers() {
  const site = currentSiteId();
  const rows = filteredVouchers();

  // Batches are how stock arrives, so they are how a mistaken upload is undone.
  const sel = $("#vf-batch");
  if (sel) {
    const batches = [...new Set(db.vouchers.filter((v) => inSite(v, site)).map((v) => v.batch).filter(Boolean))].sort().reverse();
    const prev = ui.vfilters.batch || "all";
    sel.innerHTML = `<option value="all">ANY BATCH</option>` +
      batches.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
    sel.value = batches.includes(prev) ? prev : "all";
    ui.vfilters.batch = sel.value;
  }

  // Sold vouchers are the record of a sale and can never be deleted — the
  // rules refuse it too — so a purge only ever offers the unsold ones.
  const purgeable = rows.filter((v) => v.status === "available");
  const btn = $("#btn-purge-filtered");
  const note = $("#voucher-purge-note");
  if (btn) {
    btn.hidden = purgeable.length === 0;
    btn.textContent = `✕ PURGE ${purgeable.length}`;
  }
  if (note) {
    const sold = rows.length - purgeable.length;
    note.hidden = purgeable.length === 0;
    note.textContent = `PURGE deletes the ${purgeable.length} unsold voucher${purgeable.length === 1 ? "" : "s"} listed below`
      + (sold ? `; the ${sold} already sold stay, since they are the record of a sale.` : ".");
  }

  const anyInScope = db.vouchers.some((v) => inSite(v, site));
  $("#voucher-empty").hidden = anyInScope;
  $("#voucher-table").style.display = anyInScope ? "" : "none";

  const MAX = 400;
  $("#voucher-tbody").innerHTML = rows.slice(0, MAX).map((v) => `
    <tr>
      <td class="cell-code ${v.status === "sold" ? "is-sold" : ""}">${esc(v.code)}</td>
      <td>${typeChip(v.type)}</td>
      <td>${esc(siteName(v.siteId))}</td>
      <td>${v.status === "available"
        ? `<span class="chip chip-ok"><i></i>AVAILABLE</span>`
        : v.status === "void"
        ? `<span class="chip chip-off"><i></i>VOID</span>`
        : `<span class="chip chip-sold"><i></i>SOLD</span>`}</td>
      <td class="cell-date">${esc(v.batch)}</td>
      <td class="cell-date">${fmtDate(v.uploadedAt)}</td>
      <td>${v.status === "available"
        ? `<button class="row-act danger" data-action="del-voucher" data-id="${v.id}">PURGE</button>` : ""}</td>
    </tr>`).join("") +
    (rows.length > MAX ? `<tr><td colspan="7" class="cell-none">SHOWING ${MAX} OF ${rows.length} — REFINE FILTERS TO SEE MORE</td></tr>` : "");
}

function addVoucherCodes(type, siteId, codes, batch, uploadedAt) {
  // Codes are unique per site, so the same batch can be loaded at two shops.
  const existing = new Set(db.vouchers.filter((v) => v.siteId === siteId).map((v) => v.code));
  let added = 0, skipped = 0;
  for (const raw of codes) {
    const code = String(raw).trim().toUpperCase();
    if (!code) continue;
    if (existing.has(code)) { skipped++; continue; }
    existing.add(code);
    const v = { id: newId(), code, type, siteId, status: "available", batch, uploadedAt };
    db.vouchers.push(v);
    touch("vouchers", v);
    added++;
  }
  return { added, skipped };
}

// Deletes every unsold voucher in the current view. Uploading a wrong file is
// easy and the ledger fills with hundreds of dead codes; purging them one at a
// time, each behind its own confirmation, is not a real way out of that.
async function purgeFilteredVouchers() {
  if (!isAdmin()) return toast("Administrators only", "err");
  const doomed = filteredVouchers().filter((v) => v.status === "available");
  if (!doomed.length) return toast("Nothing to purge in this view", "err");

  const site = currentSiteId();
  const where = site ? ` at ${siteName(site)}` : " across every site";
  const { type, status, batch } = ui.vfilters;
  const narrowed = [
    type !== "all" ? VTYPES[type].label : null,
    batch && batch !== "all" ? `batch ${batch}` : null,
  ].filter(Boolean).join(" · ");

  if (!(await confirmDlg(
    `Permanently delete ${doomed.length} unsold voucher${doomed.length === 1 ? "" : "s"}${where}${narrowed ? ` (${narrowed})` : ""}? ` +
    `Sold vouchers are never touched. This cannot be undone.`))) return;

  const btn = $("#btn-purge-filtered");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "◈ PURGING…";
  try {
    const { removed, failed } = await Backend.dropMany("vouchers", doomed.map((v) => v.id));
    const gone = new Set(doomed.slice(0, removed).map((v) => v.id));
    db.vouchers = db.vouchers.filter((v) => !gone.has(v.id));
    save(); renderAll();
    toast(failed
      ? `${removed} voucher(s) purged · ${failed} refused by the server`
      : `${removed} voucher${removed === 1 ? "" : "s"} purged`, failed ? "err" : "ok");
  } catch (e) {
    toast(cloudError(e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function uploadVouchers(type, rawText) {
  const siteId = uploadSiteId();
  if (!siteId) return toast("Create and select a site before uploading vouchers", "err");
  const codes = rawText.split(/[\s,;]+/).filter(Boolean);
  if (codes.length === 0) return toast("Paste at least one voucher code", "err");
  const batch = "B-" + Date.now().toString(36).toUpperCase();
  const { added, skipped } = addVoucherCodes(type, siteId, codes, batch, new Date().toISOString());
  if (added === 0) return toast("All codes already exist at this site — nothing uploaded", "err");
  save(); renderAll();
  toast(`Batch ${batch}: ${added} × ${VTYPES[type].label} loaded to ${siteName(siteId)}${skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}`);
}

const CODE_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function generateCodes(type, count, siteId) {
  const existing = new Set(db.vouchers.filter((v) => !siteId || v.siteId === siteId).map((v) => v.code));
  const out = [];
  while (out.length < count) {
    let code = VTYPES[type].prefix + "-";
    for (let i = 0; i < 8; i++) {
      if (i === 4) code += "-";
      code += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
    }
    if (!existing.has(code)) { existing.add(code); out.push(code); }
  }
  return out;
}

async function importVoucherFile(file) {
  const siteId = uploadSiteId();
  if (!siteId) return toast("Create and select a site before importing vouchers", "err");
  let result;
  try {
    result = await NexusImport.readVoucherFile(file);
  } catch (err) {
    return toast(`Could not read ${file.name} — ${err.message}`, "err");
  }
  const { entries, detected, unknown } = result;
  if (entries.length === 0) return toast(`No voucher codes found in ${file.name}`, "err");

  const parts = TYPE_ORDER.filter((t) => detected[t] > 0).map((t) => `${detected[t]} × ${VTYPES[t].label}`);
  if (unknown > 0) parts.push(`${unknown} × ${VTYPES[ui.uploadType].label} (no price match)`);
  if (!(await confirmDlg(`Import ${entries.length} codes from ${file.name} into ${siteName(siteId)}? → ${parts.join(" · ")}`))) return;

  const batch = "F-" + Date.now().toString(36).toUpperCase();
  const now = new Date().toISOString();
  let added = 0, skipped = 0;
  for (const t of TYPE_ORDER) {
    const codes = entries.filter((e) => (e.type || ui.uploadType) === t).map((e) => e.code);
    if (codes.length === 0) continue;
    const r = addVoucherCodes(t, siteId, codes, batch, now);
    added += r.added; skipped += r.skipped;
  }
  if (added === 0) return toast(`Every code already exists at ${siteName(siteId)} — nothing imported`, "err");
  save(); renderAll();
  toast(`Batch ${batch}: ${added} voucher${added === 1 ? "" : "s"} imported to ${siteName(siteId)}${skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}`);
}

/* ------------------------------------------------------------
   Admin credit oversight
   ------------------------------------------------------------ */
function renderAdminCredit() {
  const site = currentSiteId();
  const open = openAccounts(site);
  const owed = open.reduce((sum, x) => sum + x.balance, 0);
  const collected = db.payments
    .filter((p) => !site || (accountById(p.accountId) || {}).siteId === site)
    .reduce((sum, p) => sum + p.amount, 0);
  const oldest = open.length
    ? open.map((x) => accountOpenSales(x.account.id)[0]).filter(Boolean)
        .sort((a, b) => a.soldAt.localeCompare(b.soldAt))[0] : null;

  $("#credit-tiles").innerHTML = `
    <div class="tile tile-warn">
      <p class="tile-label">TOTAL OUTSTANDING</p>
      <p class="tile-value">${moneyCompact(owed)}</p>
      <p class="tile-sub">${open.length} OPEN ACCOUNT${open.length === 1 ? "" : "S"}</p>
    </div>
    <div class="tile">
      <p class="tile-label">SETTLED TO DATE</p>
      <p class="tile-value">${moneyCompact(collected)}</p>
      <p class="tile-sub">${db.payments.length} PAYMENT${db.payments.length === 1 ? "" : "S"} RECORDED</p>
    </div>
    <div class="tile">
      <p class="tile-label">OLDEST UNPAID</p>
      <p class="tile-value">${oldest ? Math.floor((Date.now() - new Date(oldest.soldAt)) / 864e5) + "d" : "—"}</p>
      <p class="tile-sub">${oldest ? esc(oldest.customer).toUpperCase() : "NO OPEN DEBT"}</p>
    </div>`;

  renderAccountsTable("#admin-accounts-tbody", "#admin-accounts-empty", "#admin-accounts-table", site, true);

  const pays = db.payments
    .filter((p) => !site || (accountById(p.accountId) || {}).siteId === site)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 60);
  $("#payments-tbody").innerHTML = pays.map((p) => {
    const acc = accountById(p.accountId);
    return `<tr>
      <td class="cell-date">${fmtDateTime(p.receivedAt)}</td>
      <td>${acc ? esc(acc.name) : "—"}</td>
      <td class="num">${money(p.amount)}</td>
      <td>${esc(PAY_METHODS[p.method] || p.method)}</td>
      <td>${esc(p.receivedByName)}</td>
      <td>${esc(p.note || "")}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="cell-none">NO SETTLEMENTS RECORDED YET</td></tr>`;
}

/* Shared accounts table — used by admin oversight and the agent view. */
function renderAccountsTable(tbodySel, emptySel, tableSel, siteId, adminView) {
  const f = adminView ? ui.creditFilters : ui.agCreditFilters;
  const qField = adminView ? $("#credit-q") : $("#ag-credit-q");
  const q = (f.q !== undefined ? f.q : (qField ? qField.value : "")).trim().toLowerCase();
  const ageFilter = f.age || "all";
  const dateFilter = f.date || "all";
  const sortBy = f.sort || "age-desc";

  // Pre-calculate debt age and payment info for all open accounts
  const allAccounts = openAccounts(siteId).map(({ account, balance }) => {
    const open = accountOpenSales(account.id);
    const oldest = open[0] || null;
    const oldestTs = oldest ? new Date(oldest.soldAt).getTime() : 0;
    const age = oldestTs ? Math.max(0, Math.floor((Date.now() - oldestTs) / 864e5)) : 0;
    const last = accountPayments(account.id)[0] || null;
    const lastPaymentTs = last ? new Date(last.receivedAt).getTime() : 0;
    const daysSincePayment = last ? Math.max(0, Math.floor((Date.now() - lastPaymentTs) / 864e5)) : null;
    return { account, balance, open, oldest, oldestTs, age, last, lastPaymentTs, daysSincePayment };
  });

  let rows = allAccounts;

  // Filter: search by customer name or phone
  if (q) {
    rows = rows.filter(({ account }) =>
      `${account.name} ${account.phone || ""}`.toLowerCase().includes(q)
    );
  }

  // Filter: by debt age
  if (ageFilter === "recent") {
    rows = rows.filter((x) => x.age <= 7);
  } else if (ageFilter === "medium") {
    rows = rows.filter((x) => x.age >= 8 && x.age <= 30);
  } else if (ageFilter === "overdue") {
    rows = rows.filter((x) => x.age > 30);
  } else if (ageFilter === "critical") {
    rows = rows.filter((x) => x.age > 60);
  }

  // Filter: by payment date
  if (dateFilter === "paid-7d") {
    rows = rows.filter((x) => x.daysSincePayment !== null && x.daysSincePayment <= 7);
  } else if (dateFilter === "paid-30d") {
    rows = rows.filter((x) => x.daysSincePayment !== null && x.daysSincePayment <= 30);
  } else if (dateFilter === "unpaid-30d") {
    rows = rows.filter((x) => x.daysSincePayment === null || x.daysSincePayment > 30);
  } else if (dateFilter === "never") {
    rows = rows.filter((x) => x.last === null);
  }

  // Sort
  rows.sort((a, b) => {
    switch (sortBy) {
      case "age-desc":
        return (b.age - a.age) || (b.balance - a.balance) || a.account.name.localeCompare(b.account.name);
      case "age-asc":
        return (a.age - b.age) || (b.balance - a.balance) || a.account.name.localeCompare(b.account.name);
      case "date-desc":
        if (a.lastPaymentTs && b.lastPaymentTs) return b.lastPaymentTs - a.lastPaymentTs;
        if (a.lastPaymentTs) return -1;
        if (b.lastPaymentTs) return 1;
        return (b.balance - a.balance);
      case "date-asc":
        if (a.lastPaymentTs && b.lastPaymentTs) return a.lastPaymentTs - b.lastPaymentTs;
        if (a.lastPaymentTs) return -1;
        if (b.lastPaymentTs) return 1;
        return (b.balance - a.balance);
      case "bal-desc":
        return (b.balance - a.balance) || (b.age - a.age);
      case "bal-asc":
        return (a.balance - b.balance) || (b.age - a.age);
      case "name-asc":
        return a.account.name.localeCompare(b.account.name);
      case "name-desc":
        return b.account.name.localeCompare(a.account.name);
      case "open-desc":
        return (b.open.length - a.open.length) || (b.balance - a.balance);
      case "open-asc":
        return (a.open.length - b.open.length) || (b.balance - a.balance);
      case "site-asc":
        return siteName(a.account.siteId).localeCompare(siteName(b.account.siteId));
      case "site-desc":
        return siteName(b.account.siteId).localeCompare(siteName(a.account.siteId));
      default:
        return (b.age - a.age) || (b.balance - a.balance);
    }
  });

  const total = allAccounts.length;
  const count = rows.length;
  const isFiltered = Boolean(q || ageFilter !== "all" || dateFilter !== "all" || sortBy !== "age-desc");

  // Summary badge and reset button
  const badge = $(adminView ? "#credit-count-badge" : "#ag-credit-count-badge");
  if (badge) {
    badge.textContent = total === 0 ? ""
      : isFiltered ? `${count} OF ${total} ACCOUNTS`
      : `${total} OPEN ACCOUNT${total === 1 ? "" : "S"}`;
  }
  const resetBtn = $(adminView ? "#btn-credit-reset" : "#btn-ag-credit-reset");
  if (resetBtn) {
    resetBtn.hidden = !isFiltered;
  }

  // Update sortable header classes & arrows
  const [sortKey, sortDir] = sortBy.split("-");
  const table = $(tableSel);
  if (table) {
    table.querySelectorAll("th.th-sortable").forEach((th) => {
      const col = th.dataset.sort;
      const isSorted = col === sortKey || (col === "balance" && sortKey === "bal");
      th.classList.toggle("is-sorted", isSorted);
      th.setAttribute("aria-sort", isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none");
      const arrow = th.querySelector(".sort-arrow");
      if (arrow) {
        arrow.textContent = isSorted ? (sortDir === "asc" ? "▲" : "▼") : "";
      }
    });
  }

  const emptyEl = $(emptySel);
  if (emptyEl) emptyEl.hidden = total !== 0;
  if (table) table.style.display = total === 0 ? "none" : "";

  const tbody = $(tbodySel);
  if (!tbody) return;

  if (total > 0 && count === 0) {
    tbody.innerHTML = `<tr><td colspan="${adminView ? 7 : 6}" class="cell-none">NO ACCOUNTS MATCH THE SELECTED FILTERS</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(({ account, balance, open, age, last, daysSincePayment }) => {
    const ageClass = age > 60 ? "age-critical" : age > 30 ? "age-overdue" : age <= 7 ? "age-recent" : "age-medium";
    const lastDisplay = last
      ? `<span class="cell-date">${fmtDate(last.receivedAt)}</span>${daysSincePayment !== null ? `<span class="cell-sub mono">${daysSincePayment === 0 ? "today" : `${daysSincePayment}d ago`}</span>` : ""}`
      : `<span class="dim mono">NEVER</span>`;

    return `<tr>
      <td>${esc(account.name)}${account.phone ? `<span class="cell-sub mono">${esc(account.phone)}</span>` : ""}</td>
      ${adminView ? `<td>${esc(siteName(account.siteId))}</td>` : ""}
      <td class="num">${open.length}</td>
      <td class="num owed-strong">${money(balance)}</td>
      <td><span class="age-badge ${ageClass}">${age}d</span> <span class="cell-date dim">${age === 1 ? "1 day" : `${age} days`}</span></td>
      <td>${lastDisplay}</td>
      <td class="row-acts">
        <button class="row-act" data-action="view-account" data-id="${account.id}">STATEMENT</button>
        <button class="row-act accent" data-action="settle" data-id="${account.id}">SETTLE</button>
      </td>
    </tr>`;
  }).join("");
}

// Whether an agent has finished a period. On ALL SITES an agent who works
// two sites and has closed one is not done, and saying CLOSED would invite
// the shop to settle up with them early.
function closedLabel(userId, period, siteId) {
  if (siteId) return closingFor(userId, period, siteId) ? "CLOSED" : "OPEN";
  const worked = sitesWorked(userId, period);
  const closed = closingsFor(userId, period).length;
  if (closed === 0) return "OPEN";
  if (worked.length > 1 && closed < worked.length) return `CLOSED ${closed}/${worked.length} SITES`;
  return "CLOSED";
}

/* ------------------------------------------------------------
   Admin reports — all agents, one period
   ------------------------------------------------------------ */
function renderAdminReports() {
  const period = $("#rep-period").value || monthKey(new Date());
  const site = currentSiteId();
  const overall = buildReport(null, period, site);

  $("#rep-tiles").innerHTML = `
    <div class="tile">
      <p class="tile-label">TOTAL CASH COLLECTED</p>
      <p class="tile-value">${moneyCompact(overall.totalCashCollected)}</p>
      <p class="tile-sub">SALES ${money(overall.cashSalesTotal)} · SETTLEMENTS ${money(overall.debtCollected)}</p>
    </div>
    <div class="tile tile-warn">
      <p class="tile-label">CREDIT ISSUED</p>
      <p class="tile-value">${moneyCompact(overall.creditIssued)}</p>
      <p class="tile-sub">${overall.creditCount} SALE${overall.creditCount === 1 ? "" : "S"} · ${money(overall.unpaidFromPeriod)} OF IT STILL UNPAID TODAY</p>
    </div>
    <div class="tile">
      <p class="tile-label">TRANSACTIONS</p>
      <p class="tile-value">${overall.salesCount}</p>
      <p class="tile-sub">${overall.cashCount} CASH · ${overall.creditCount} CREDIT</p>
    </div>
    <div class="tile tile-warn">
      <p class="tile-label">OUTSTANDING NOW</p>
      <p class="tile-value">${moneyCompact(overall.outstandingNow)}</p>
      <p class="tile-sub">ACROSS ${openAccounts(site).length} ACCOUNT(S)</p>
    </div>`;

  const agents = db.users.filter((u) => u.role === "agent" || db.sales.some((s) => s.agentId === u.id));
  $("#rep-tbody").innerHTML = agents.map((u) => {
    const r = buildReport(u.id, period, site);
    const closed = closingFor(u.id, period, site);
    if (r.salesCount === 0 && r.paymentsCount === 0) return "";
    return `<tr>
      <td>${esc(u.name)}<span class="cell-sub">${esc(u.code)}</span></td>
      <td class="num">${r.salesCount}</td>
      <td class="num">${money(r.cashSalesTotal)}</td>
      <td class="num">${money(r.debtCollected)}</td>
      <td class="num strong">${money(r.totalCashCollected)}</td>
      <td class="num">${money(r.creditIssued)}</td>
      <td class="num owed-strong">${money(r.unpaidFromPeriod)}</td>
      <td>${closed
        ? `<span class="chip chip-ok"><i></i>CLOSED</span>`
        : `<span class="chip chip-off"><i></i>OPEN</span>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="cell-none">NO ACTIVITY IN ${fmtMonth(period)}</td></tr>`;

  const closings = db.closings
    .filter((c) => c.period === period && (!site || c.siteId === site))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  $("#closings-tbody").innerHTML = closings.map((c) => `
    <tr>
      <td>${esc(c.userName)}</td>
      <td>${esc(siteName(c.siteId))}</td>
      <td class="cell-date">${fmtDateTime(c.generatedAt)}</td>
      <td class="num strong">${money(c.totals.totalCashCollected)}</td>
      <td class="num owed-strong">${money(c.totals.unpaidFromPeriod)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="cell-none">NO MONTHS CLOSED FOR ${fmtMonth(period)}</td></tr>`;
}

function exportReportCSV() {
  const period = $("#rep-period").value || monthKey(new Date());
  const site = currentSiteId();
  const rows = [["NEXUS//POS month-end report", fmtMonth(period), site ? siteName(site) : "ALL SITES"], [],
    ["Agent", "Code", "Sales", "Cash sales", "Debt collected", "Total cash collected", "Credit issued", "Unpaid today", "Status"]];
  for (const u of db.users) {
    const r = buildReport(u.id, period, site);
    if (r.salesCount === 0 && r.paymentsCount === 0) continue;
    rows.push([u.name, u.code, r.salesCount, r.cashSalesTotal, r.debtCollected,
      r.totalCashCollected, r.creditIssued, r.unpaidFromPeriod,
      closedLabel(u.id, period, site)]);
  }
  const o = buildReport(null, period, site);
  rows.push([], ["TOTAL", "", o.salesCount, o.cashSalesTotal, o.debtCollected,
    o.totalCashCollected, o.creditIssued, o.unpaidFromPeriod, ""]);
  downloadCSV(`nexus-pos-report-${period}.csv`, rows);
  toast(`Exported the ${fmtMonth(period)} report`);
}

/* ------------------------------------------------------------
   Cash-outs — the reconciliation ledger

   The month-end report says what each agent collected. It never said
   what they had actually handed in, so a shop could read a clean set of
   reports and still not know who was sitting on the takings.

   Two views, because they answer different questions. The position table
   asks "who owes us money right now", across every month, including ones
   already closed — closing a month freezes what was collected, it does
   not mean the cash arrived. The ledger underneath is the audit trail:
   every hand-over, who recorded it, and any that were voided.
   ------------------------------------------------------------ */

// Anyone who has traded, closed a month, or handed cash over.
const cashAgents = () => db.users.filter((u) =>
  u.role === "agent"
  || db.sales.some((s) => s.agentId === u.id)
  || db.cashouts.some((c) => c.userId === u.id));

// Every agent-month with anything to say: money collected, handed over,
// or a month closed. Newest month first — that is how it gets read.
function cashPositions(siteId, onlyUser, onlyPeriod) {
  const rows = [];
  for (const u of cashAgents()) {
    if (onlyUser && u.id !== onlyUser) continue;
    for (const period of cashPeriods(u.id, siteId)) {
      if (onlyPeriod && period !== onlyPeriod) continue;
      const sites = siteId ? [siteId] : sitesTouched(u.id, period);
      for (const s of sites) {
        const pos = cashPosition(u.id, period, s);
        if (pos.due === 0 && pos.handedOver === 0) continue;
        rows.push(Object.assign({ user: u, siteId: s }, pos));
      }
    }
  }
  return rows.sort((a, b) =>
    b.period.localeCompare(a.period) || a.user.name.localeCompare(b.user.name));
}

// Which sites an agent's money for a period sits under. Cash is accounted
// for per site, so an agent working two shops owes each of them separately.
const sitesTouched = (userId, period) => {
  const set = new Set(sitesWorked(userId, period));
  for (const c of db.cashouts) {
    if (c.userId === userId && c.period === period && !c.voidedAt) set.add(c.siteId || "");
  }
  for (const c of db.closings) {
    if (c.userId === userId && c.period === period) set.add(c.siteId || "");
  }
  return set.size ? [...set] : [""];
};

function renderCashLedger() {
  const site = currentSiteId();
  const period = $("#cash-period").value || "";
  const who = $("#cash-agent").value || "";

  // Keep the agent picker in step without losing the current choice.
  const agents = cashAgents();
  const sel = $("#cash-agent");
  const keep = sel.value;
  sel.innerHTML = `<option value="">ALL AGENTS</option>` +
    agents.map((u) => `<option value="${u.id}">${esc(u.name)} · ${esc(u.code)}</option>`).join("");
  sel.value = agents.some((u) => u.id === keep) ? keep : "";

  const rows = cashPositions(site, who, period);
  const held = rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
  const over = rows.reduce((s, r) => s + r.handedOver, 0);
  const owing = rows.filter((r) => r.outstanding > 0);

  $("#cash-tiles").innerHTML = `
    <div class="tile ${held > 0 ? "tile-warn" : ""}">
      <p class="tile-label">STILL WITH AGENTS</p>
      <p class="tile-value">${money(held)}</p>
      <p class="tile-sub">${owing.length} AGENT-MONTH${owing.length === 1 ? "" : "S"} OUTSTANDING</p>
    </div>
    <div class="tile">
      <p class="tile-label">HANDED OVER</p>
      <p class="tile-value">${money(over)}</p>
      <p class="tile-sub">ACROSS ${rows.length} AGENT-MONTH${rows.length === 1 ? "" : "S"}</p>
    </div>
    <div class="tile">
      <p class="tile-label">COLLECTED</p>
      <p class="tile-value">${money(rows.reduce((s, r) => s + r.due, 0))}</p>
      <p class="tile-sub">CASH SALES · DEBT SETTLEMENTS</p>
    </div>`;

  $("#cash-note").textContent = period
    ? `Showing ${fmtMonth(period)} only. Clear the month to see every period, including closed ones that still owe.`
    : "Every month with money in it, newest first. A closed month keeps owing until the cash is handed in — closing freezes the takings, it does not collect them.";

  $("#cash-position-tbody").innerHTML = rows.length === 0
    ? `<tr><td colspan="7" class="empty">Nothing collected yet.</td></tr>`
    : rows.map((r) => `
      <tr>
        <td>${esc(r.user.name)}<span class="cell-sub">${esc(r.user.code)}</span></td>
        <td>${esc(siteName(r.siteId) || "—")}</td>
        <td>${esc(fmtMonth(r.period))}</td>
        <td class="num">${money(r.due)}</td>
        <td class="num">${money(r.handedOver)}</td>
        <td class="num ${r.outstanding > 0 ? "owed-strong" : ""}">${money(r.outstanding)}</td>
        <td>${r.closed ? `<span class="chip chip-ok"><i></i>CLOSED</span>` : `<span class="chip chip-off"><i></i>OPEN</span>`}</td>
      </tr>`).join("");

  const ledger = db.cashouts
    .filter((c) => (!site || (c.siteId || "") === site)
                && (!who || c.userId === who)
                && (!period || c.period === period))
    .slice().sort((a, b) => (a.handedOverAt < b.handedOverAt ? 1 : -1));

  const voidedCount = ledger.filter((c) => c.voidedAt).length;
  $("#cash-ledger-count").innerHTML = `<span class="chip chip-v10"><i></i>${ledger.length} ENTR${ledger.length === 1 ? "Y" : "IES"}</span>` +
    (voidedCount ? ` <span class="chip chip-sold"><i></i>${voidedCount} VOIDED</span>` : "");

  $("#cash-ledger-tbody").innerHTML = ledger.length === 0
    ? `<tr><td colspan="9" class="empty">No hand-overs recorded.</td></tr>`
    : ledger.map((c) => `
      <tr class="${c.voidedAt ? "row-reversed" : ""}">
        <td class="cell-date">${fmtDateTime(c.handedOverAt)}</td>
        <td>${esc(c.userName)}</td>
        <td>${esc(siteName(c.siteId) || "—")}</td>
        <td>${esc(fmtMonth(c.period))}</td>
        <td class="num">${money(c.amount)}</td>
        <td>${esc(PAY_METHODS[c.method] || c.method)}</td>
        <td>${esc(c.reference || "—")}</td>
        <td>${esc(c.recordedByName)}<span class="cell-sub">${c.recordedByRole === "admin" ? "received by an administrator" : "declared by the agent"}</span>
          ${c.voidedAt ? `<span class="rev-note">VOIDED by ${esc(c.voidedByName || "—")} — ${esc(c.voidReason || "")}</span>` : ""}</td>
        <td class="row-actions">${c.voidedAt ? "" :
          `<button class="row-act danger" data-action="void-cashout" data-id="${c.id}">VOID</button>`}</td>
      </tr>`).join("");
}

// An administrator receiving cash directly, booked against the agent it
// came from. Recorded as "received by an administrator" rather than an
// agent's own declaration, because the two are not the same claim.
function openAdminCashout() {
  const agents = cashAgents().filter((u) => u.status === "active");
  if (!agents.length) return toast("No agents to receive cash from", "err");

  const who = $("#cash-agent").value || agents[0].id;
  const user = userById(who) || agents[0];
  const site = currentSiteId();
  const open = openCashPeriods(user.id, site);
  if (!open.length) return toast(`${user.name} has nothing outstanding${site ? ` at ${siteName(site)}` : ""}`);

  ui.cashoutFor = { userId: user.id, siteId: open[0].siteId || site };
  $("#cashout-who").textContent = user.name;
  $("#cashout-meta").textContent = ` · ${user.code} · receiving on their behalf`;
  $("#cashout-period").innerHTML = open.map((p) =>
    `<option value="${p.period}">${esc(fmtMonth(p.period))} — ${money(p.outstanding)} owing</option>`).join("");
  $("#cashout-period").value = open[0].period;
  $("#cashout-amount").value = "";
  $("#cashout-ref").value = "";
  $("#cashout-method").value = "cash";
  $("#cashout-err").hidden = true;
  syncCashoutOwed();
  $("#modal-cashout").hidden = false;
  setTimeout(() => $("#cashout-amount").focus(), 40);
}

function openVoidCashout(id) {
  const c = db.cashouts.find((x) => x.id === id);
  if (!c) return;
  if (c.voidedAt) return toast("That hand-over is already voided", "err");
  ui.voidCashout = id;
  $("#voidcash-what").textContent =
    `${money(c.amount)} from ${c.userName}, covering ${fmtMonth(c.period)}, recorded ${fmtDateTime(c.handedOverAt)}.`;
  $("#voidcash-reason").value = "";
  $("#voidcash-err").hidden = true;
  $("#modal-voidcash").hidden = false;
  setTimeout(() => $("#voidcash-reason").focus(), 40);
}

async function submitVoidCashout() {
  const c = db.cashouts.find((x) => x.id === ui.voidCashout);
  const reason = $("#voidcash-reason").value.trim();
  const fail = (msg) => {
    const err = $("#voidcash-err");
    err.textContent = msg; err.hidden = false;
  };
  if (!c) return fail("That hand-over is no longer there.");
  if (!isAdmin()) return fail("Administrators only.");
  if (!reason) return fail("Say why — it goes on the record.");

  const me = currentUser();
  const btn = $("#voidcash-confirm");
  btn.disabled = true;
  try {
    // Only the void fields change; the rules refuse anything else, and the
    // amount and month are the whole point of the entry.
    Object.assign(c, {
      voidedAt: new Date().toISOString(),
      voidedBy: me.id, voidedByName: me.name, voidReason: reason,
    });
    touch("cashouts", c);
    save();
    $("#modal-voidcash").hidden = true;
    renderAll();
    toast(`Voided ${money(c.amount)} from ${c.userName} — ${fmtMonth(c.period)} is owing again`);
  } catch (e) {
    fail(cloudError(e));
  } finally {
    btn.disabled = false;
  }
}

function exportCashLedgerCSV() {
  const site = currentSiteId();
  const period = $("#cash-period").value || "";
  const who = $("#cash-agent").value || "";
  const rows = cashPositions(site, who, period);
  const ledger = db.cashouts
    .filter((c) => (!site || (c.siteId || "") === site)
                && (!who || c.userId === who)
                && (!period || c.period === period))
    .slice().sort((a, b) => (a.handedOverAt < b.handedOverAt ? 1 : -1));

  downloadCSV(`nexus-pos-cashouts-${period || "all"}.csv`, [
    ["NEXUS//POS cash hand-over ledger"],
    ["Site", site ? siteName(site) : "ALL SITES"],
    ["Period", period ? fmtMonth(period) : "ALL PERIODS"],
    ["Generated", new Date().toISOString()],
    [],
    ["POSITION"],
    ["Agent", "Code", "Site", "Month", "Collected", "Handed over", "Still held", "Month status"],
    ...rows.map((r) => [r.user.name, r.user.code, siteName(r.siteId), r.period,
      r.due, r.handedOver, r.outstanding, r.closed ? "CLOSED" : "OPEN"]),
    [],
    ["LEDGER"],
    ["When", "Agent", "Site", "Covers", "Amount", "Method", "Reference", "Recorded by", "Role", "Voided", "Void reason"],
    ...ledger.map((c) => [c.handedOverAt, c.userName, siteName(c.siteId), c.period,
      c.amount, PAY_METHODS[c.method] || c.method, c.reference || "",
      c.recordedByName, c.recordedByRole, c.voidedAt || "", c.voidReason || ""]),
  ]);
  toast("Exported the cash-out ledger");
}

/* ------------------------------------------------------------
   Cloud backend panel
   ------------------------------------------------------------ */
function renderCloud() {
  const st = Backend.ready ? Backend.status.toUpperCase() : "NOT CONNECTED";
  const chip = Backend.status === "online" && Backend.ready ? "chip-ok"
    : Backend.status === "error" ? "chip-sold" : "chip-v10";

  $("#cloud-status").innerHTML = `<span class="chip ${chip}"><i></i>${st}</span>` +
    (Backend.pending ? ` <span class="chip chip-v10"><i></i>${Backend.pending} QUEUED</span>` : "") +
    (Backend.error ? `<span class="cell-sub owed">${esc(Backend.error)}</span>` : "");

  $("#cloud-summary").innerHTML = `
    <div><dt>APP VERSION</dt><dd>${esc(AppVersion.full)}${
      AppVersion.stamped ? `<span class="cell-sub">built ${esc(AppVersion.builtLabel)}</span>` : ""}${
      AppVersion.updateAvailable() ? `<span class="cell-sub owed">v${esc(AppVersion.latest.release)} released — reload to update</span>` : ""}</dd></div>
    <div><dt>PROJECT</dt><dd>${esc((Backend.config || {}).projectId || "—")}</dd></div>
    <div><dt>DATABASE</dt><dd>${esc((Backend.config || {}).firestoreDatabaseId || "(default)")}</dd></div>
    <div><dt>SIGNED IN AS</dt><dd>${esc((currentUser() || {}).name || "—")}</dd></div>
    <div><dt>RECORDS HELD</dt><dd>${db.sites.length} sites · ${db.users.length} staff · ${db.vouchers.length} vouchers · ${db.sales.length} sales</dd></div>`;

  const box = $("#cloud-config");
  if (box && !box.value.trim() && Backend.config) {
    const shown = Object.assign({}, Backend.config);
    delete shown.autoConnect;
    delete shown.useEmulators;
    box.value = JSON.stringify(shown, null, 2);
  }
  const emuBox = $("#cloud-emulators");
  const warn = $("#cloud-emu-warn");
  if (emuBox && warn) warn.hidden = !emuBox.checked;
  $("#btn-cloud-diag").disabled = !(Backend.config || (typeof window !== "undefined" && window.NEXUS_FIREBASE_CONFIG));

  // Settlements recorded before payments carried their site are invisible to
  // agents, who can only query by site — and a balance missing a payment tells
  // them a customer still owes money they have already handed over.
  const orphans = paymentsMissingSite();
  const repair = $("#cloud-repair");
  if (repair) {
    repair.hidden = orphans.length === 0;
    $("#cloud-repair-note").textContent =
      `${orphans.length} settlement${orphans.length === 1 ? "" : "s"} recorded before this version do not carry a site, so agents cannot see them.`;
  }
  const local = readLocalStore();
  $("#btn-cloud-push").disabled = !cloudMode() || !local;
  $("#cloud-push-note").textContent = local
    ? `This browser still holds an older device-only store: ${local.sites.length} sites · ${local.users.length} staff · ${local.vouchers.length} vouchers · ${local.sales.length} sales · ${local.payments.length} payments.`
    : "Nothing to import — this browser has no records from the older device-only version.";
}

// Settlements written before payments carried their account's site.
const paymentsMissingSite = () => db.payments.filter((p) => !p.siteId);

// Stamps the site onto those records. Payments are immutable by rule, with a
// single exception for exactly this: an admin adding the missing siteId, and
// only where it matches the account the payment already points at.
async function repairPaymentSites() {
  if (!isAdmin()) return toast("Administrators only", "err");
  const orphans = paymentsMissingSite();
  if (!orphans.length) return toast("Every settlement already carries its site");

  const fixable = orphans.filter((p) => accountById(p.accountId));
  if (!fixable.length) {
    return toast(`${orphans.length} settlement(s) reference accounts this till cannot see — sign in as an administrator with access to every site`, "err");
  }
  if (!(await confirmDlg(
    `Stamp the site onto ${fixable.length} older settlement(s)? Agents cannot see them until you do, which makes their customers look like they still owe the money. Nothing else about the records changes.`))) return;

  const btn = $("#btn-cloud-repair");
  btn.disabled = true;
  let done = 0, failed = 0;
  for (const p of fixable) {
    const acc = accountById(p.accountId);
    try {
      await Backend.update("payments", p.id, { siteId: acc.siteId });
      p.siteId = acc.siteId;
      done++;
    } catch (e) { failed++; }
  }
  btn.disabled = false;
  save(); renderAll();
  toast(failed
    ? `${done} settlement(s) repaired · ${failed} refused — check you administer those sites`
    : `${done} settlement(s) repaired — agents can see them now`, failed ? "err" : "ok");
}

// Whatever an older, device-only version of the app left in this browser.
// Read-only: the app no longer writes here, but a till that traded offline
// before the switch still has its history sitting in localStorage.
function readLocalStore() {
  try {
    const raw = storage.getItem(DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users)) return normalizeDb(parsed);
    }
  } catch (_) { /* corrupted — try the older key */ }
  try {
    const legacy = storage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed && Array.isArray(parsed.agents)) return migrateV1(parsed);
    }
  } catch (_) { /* ignore */ }
  return null;
}

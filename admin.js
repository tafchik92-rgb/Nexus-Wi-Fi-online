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
  const sales = salesInScope(site);
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
  for (const s of salesInScope(siteId)) {
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

  $("#sales-tbody").innerHTML = rows.map((s) => {
    const owed = saleOutstanding(s);
    return `<tr>
      <td class="cell-date">${fmtDateTime(s.soldAt)}</td>
      <td>${esc(s.customer)}${s.phone ? `<span class="cell-sub mono">${esc(s.phone)}</span>` : ""}</td>
      <td class="cell-code">${esc(s.voucherCode)}</td>
      <td>${typeChip(s.type)}</td>
      <td class="num">${s.price > 0 ? money(s.price) : "—"}</td>
      <td>${payChip(s.pay)}${owed > 0 ? `<span class="cell-sub owed">OWES ${money(owed)}</span>` : ""}</td>
      <td>${esc(s.agentName)}<span class="cell-sub">${esc(siteName(s.siteId))}</span></td>
    </tr>`;
  }).join("") || (all.length > 0
    ? `<tr><td colspan="7" class="cell-none">NO RECORDS MATCH THE CURRENT FILTERS</td></tr>` : "");
}

function exportSalesCSV() {
  const rows = filteredSales();
  if (rows.length === 0) return toast("Nothing to export with the current filters", "err");
  const head = ["Date", "Site", "Customer", "Phone", "Voucher", "Type", "Price", "Payment", "Outstanding", "Agent"];
  downloadCSV(`nexus-pos-sales-${dayKey(new Date())}.csv`, [head].concat(rows.map((s) => [
    new Date(s.soldAt).toISOString(), siteName(s.siteId), s.customer, s.phone, s.voucherCode,
    VTYPES[s.type].label, s.price, s.pay.toUpperCase(), saleOutstanding(s), s.agentName,
  ])));
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
    const sales = db.sales.filter((s) => s.agentId === u.id);
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

  if (cloudMode()) {
    // The server owns credentials: it hashes the PIN and mints the record.
    try {
      await Backend.call("createStaff", { name, code, role, pin, siteIds });
    } catch (e) { return toast(cloudError(e), "err"); }
    form.reset(); renderAll();
    return toast(`${role === "admin" ? "Administrator" : "Agent"} ${name} added as ${code}`);
  }

  const user = { id: newId(), name, code, role, salt: "", pinHash: "", siteIds, status: "active", createdAt: new Date().toISOString() };
  await setUserPin(user, pin);
  db.users.push(user);
  touch("users", user);
  save(); renderAll();
  form.reset();
  toast(`${role === "admin" ? "Administrator" : "Agent"} ${name} added as ${code}`);
}

/* ------------------------------------------------------------
   Sites
   ------------------------------------------------------------ */
function renderSites() {
  $("#sites-empty").hidden = db.sites.length !== 0;
  $("#sites-table").style.display = db.sites.length === 0 ? "none" : "";

  $("#sites-tbody").innerHTML = db.sites.map((s) => {
    const sales = db.sales.filter((x) => x.siteId === s.id);
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

function renderVouchers() {
  const { type, status } = ui.vfilters;
  const site = currentSiteId();
  const rows = db.vouchers
    .filter((v) => inSite(v, site))
    .filter((v) => (type === "all" || v.type === type) && (status === "all" || v.status === status))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.code.localeCompare(b.code));

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
    const v = { id: newId(), code, type, siteId, status: "available", batch, uploadedAt, reservedBy: null };
    db.vouchers.push(v);
    touch("vouchers", v);
    added++;
  }
  return { added, skipped };
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
  const needle = (adminView ? ($("#credit-q") || {}).value : ($("#ag-credit-q") || {}).value) || "";
  const q = needle.trim().toLowerCase();
  let rows = openAccounts(siteId);
  if (q) rows = rows.filter(({ account }) =>
    `${account.name} ${account.phone}`.toLowerCase().includes(q));

  $(emptySel).hidden = openAccounts(siteId).length !== 0;
  $(tableSel).style.display = openAccounts(siteId).length === 0 ? "none" : "";

  $(tbodySel).innerHTML = rows.map(({ account, balance }) => {
    const open = accountOpenSales(account.id);
    const oldest = open[0];
    const age = oldest ? Math.floor((Date.now() - new Date(oldest.soldAt)) / 864e5) : 0;
    const last = accountPayments(account.id)[0];
    return `<tr>
      <td>${esc(account.name)}${account.phone ? `<span class="cell-sub mono">${esc(account.phone)}</span>` : ""}</td>
      ${adminView ? `<td>${esc(siteName(account.siteId))}</td>` : ""}
      <td class="num">${open.length}</td>
      <td class="num owed-strong">${money(balance)}</td>
      <td class="cell-date">${age} day${age === 1 ? "" : "s"}</td>
      <td class="cell-date">${last ? fmtDate(last.receivedAt) : "—"}</td>
      <td class="row-acts">
        <button class="row-act" data-action="view-account" data-id="${account.id}">STATEMENT</button>
        <button class="row-act accent" data-action="settle" data-id="${account.id}">SETTLE</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="${adminView ? 7 : 6}" class="cell-none">NO ACCOUNTS MATCH THIS SEARCH</td></tr>`;
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
      <p class="tile-sub">${overall.creditCount} SALE${overall.creditCount === 1 ? "" : "S"} · ${money(overall.unpaidFromPeriod)} STILL UNPAID</p>
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
    ["Agent", "Code", "Sales", "Cash sales", "Debt collected", "Total cash collected", "Credit issued", "Unpaid from period", "Status"]];
  for (const u of db.users) {
    const r = buildReport(u.id, period, site);
    if (r.salesCount === 0 && r.paymentsCount === 0) continue;
    rows.push([u.name, u.code, r.salesCount, r.cashSalesTotal, r.debtCollected,
      r.totalCashCollected, r.creditIssued, r.unpaidFromPeriod,
      closingFor(u.id, period, site) ? "CLOSED" : "OPEN"]);
  }
  const o = buildReport(null, period, site);
  rows.push([], ["TOTAL", "", o.salesCount, o.cashSalesTotal, o.debtCollected,
    o.totalCashCollected, o.creditIssued, o.unpaidFromPeriod, ""]);
  downloadCSV(`nexus-pos-report-${period}.csv`, rows);
  toast(`Exported the ${fmtMonth(period)} report`);
}

/* ------------------------------------------------------------
   Cloud backend panel
   ------------------------------------------------------------ */
function renderCloud() {
  const on = typeof Backend !== "undefined" && Backend.enabled;
  const st = !on ? "LOCAL" : (typeof Backend !== "undefined" && Backend.ready ? Backend.status.toUpperCase() : "NOT CONNECTED");
  const chip = !on ? "chip-off"
    : (typeof Backend !== "undefined" && Backend.status === "online") ? "chip-ok"
    : (typeof Backend !== "undefined" && Backend.status === "error") ? "chip-sold" : "chip-v10";

  $("#cloud-status").innerHTML = `<span class="chip ${chip}"><i></i>${st}</span>` +
    ((typeof Backend !== "undefined" && Backend.pending) ? ` <span class="chip chip-v10"><i></i>${Backend.pending} QUEUED</span>` : "") +
    ((typeof Backend !== "undefined" && Backend.error) ? `<span class="cell-sub owed">${esc(Backend.error)}</span>` : "");

  $("#cloud-summary").innerHTML = `
    <div><dt>MODE</dt><dd>${on ? "CLOUD (Firebase)" : "LOCAL (this browser)"}</dd></div>
    <div><dt>PROJECT</dt><dd>${on && typeof Backend !== "undefined" && Backend.config ? esc(Backend.config.projectId || "—") : "—"}</dd></div>
    <div><dt>SIGNED IN AS</dt><dd>${esc((currentUser() || {}).name || "—")}</dd></div>
    <div><dt>RECORDS HELD</dt><dd>${db.sites.length} sites · ${db.users.length} staff · ${db.vouchers.length} vouchers · ${db.sales.length} sales</dd></div>`;

  const box = $("#cloud-config");
  if (box && !box.value.trim() && typeof Backend !== "undefined" && Backend.config) {
    const shown = Object.assign({}, Backend.config);
    delete shown.autoConnect;
    delete shown.useEmulators;
    box.value = JSON.stringify(shown, null, 2);
  }
  $("#btn-cloud-disable").hidden = !on;
  $("#btn-cloud-push").disabled = !cloudMode();
  const local = readLocalStore();
  $("#cloud-push-note").textContent = local
    ? `Local store holds ${local.sites.length} sites · ${local.users.length} staff · ${local.vouchers.length} vouchers · ${local.sales.length} sales · ${local.payments.length} payments.`
    : "No local data found in this browser.";
}

// The untouched localStorage copy, still there after switching to cloud mode.
function readLocalStore() {
  try {
    const raw = storage.getItem(DB_KEY);
    if (!raw) return null;
    return normalizeDb(JSON.parse(raw));
  } catch (_) { return null; }
}

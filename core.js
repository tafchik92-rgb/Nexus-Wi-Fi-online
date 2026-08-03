/* ============================================================
   NEXUS//POS — core: storage, data model, auth, shared helpers
   Loaded before admin.js / agent.js / app.js.
   ============================================================ */
"use strict";

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */
const DB_KEY = "nexuspos.v2";
const LEGACY_KEY = "nexuspos.v1";
const SESSION_KEY = "nexuspos.session";

const VTYPES = {
  V5:  { label: "$5 PASS",      price: 5,  chip: "chip-v5",  prefix: "W5" },
  V10: { label: "$10 PASS",     price: 10, chip: "chip-v10", prefix: "W10" },
  REC: { label: "RECON BUNDLE", price: 0,  chip: "chip-rec", prefix: "RC" },
};
const TYPE_ORDER = ["V5", "V10", "REC"];

const PAY_METHODS = {
  cash:   "CASH",
  mobile: "MOBILE MONEY",
  bank:   "BANK TRANSFER",
};

/* ------------------------------------------------------------
   Tiny helpers
   ------------------------------------------------------------ */
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const uid = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

const money = (n) => {
  const v = Number(n) || 0;
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const moneyCompact = (n) =>
  "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n) || 0);

const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const monthKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
};
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
};
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" }).toUpperCase();
const fmtMonth = (period) => {
  const [y, m] = String(period).split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
};

/* ------------------------------------------------------------
   Storage — falls back to memory where localStorage is blocked
   ------------------------------------------------------------ */
const storage = (() => {
  try {
    const probe = "__nexuspos.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch (_) {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
    };
  }
})();

/* ------------------------------------------------------------
   Data model
   ------------------------------------------------------------ */
const emptyDb = () => ({
  v: 2, sites: [], users: [], vouchers: [], accounts: [], sales: [], payments: [], closings: [],
});

let db = emptyDb();
let _rev = 0;

const bumpRev = () => { _rev++; };
const cloudMode = () => typeof Backend !== "undefined" && Backend.enabled && Backend.ready;

// Every mutation routes through touch/drop. Local mode keeps writing the
// whole store to localStorage; cloud mode writes the individual document
// (queued durably by Firestore when offline).
function touch(collection, obj) {
  if (cloudMode()) Backend.put(collection, obj);
}
function drop(collection, id) {
  if (cloudMode()) Backend.drop(collection, id);
}
// Ids must be allocated by whichever store owns them.
function newId() {
  return cloudMode() ? Backend.newId() : uid();
}

function save() {
  _rev++;
  if (!cloudMode()) storage.setItem(DB_KEY, JSON.stringify(db));
}

function loadDb() {
  try {
    const raw = storage.getItem(DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users)) return normalizeDb(parsed);
    }
  } catch (_) { /* corrupted store — fall through to legacy/empty */ }
  try {
    const legacy = storage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed && Array.isArray(parsed.agents)) return migrateV1(parsed);
    }
  } catch (_) { /* ignore */ }
  return emptyDb();
}

function normalizeDb(d) {
  const out = Object.assign(emptyDb(), d);
  for (const key of ["sites", "users", "vouchers", "accounts", "sales", "payments", "closings"]) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  return out;
}

// v1 (single site, agents without logins) → v2
function migrateV1(old) {
  const d = emptyDb();
  const now = new Date().toISOString();
  const site = { id: uid(), name: "Main Shop", code: "S-01", status: "active", createdAt: now };
  d.sites.push(site);
  const idMap = new Map();
  for (const a of old.agents || []) {
    const u = {
      id: uid(), name: a.name, code: a.code, role: "agent",
      salt: "", pinHash: "", siteIds: [site.id],
      status: a.status === "inactive" ? "inactive" : "active",
      createdAt: a.createdAt || now,
    };
    idMap.set(a.id, u.id);
    d.users.push(u);
  }
  d.vouchers = (old.vouchers || []).map((v) => Object.assign({}, v, { siteId: site.id }));
  d.sales = (old.sales || []).map((s) => Object.assign({}, s, {
    siteId: site.id,
    agentId: idMap.get(s.agentId) || s.agentId,
    accountId: null,
  }));
  return d;
}

/* ------------------------------------------------------------
   Auth — UI-level role gate.
   NOTE: this is a browser-only app. PINs are salted+hashed so they
   are not stored in the clear, but anyone with devtools can read or
   rewrite localStorage. Treat this as workflow separation between
   staff, not as a security boundary. Wire to a real backend for that.
   ------------------------------------------------------------ */
async function hashPin(pin, salt) {
  const data = `${salt}:${pin}`;
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(data));
    return "s256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Non-secure contexts (file://) have no SubtleCrypto — degrade to a
  // non-cryptographic digest so the gate still works locally.
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "fnv:" + h.toString(16);
}

const newSalt = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function setUserPin(user, pin) {
  user.salt = newSalt();
  user.pinHash = await hashPin(pin, user.salt);
}

async function verifyPin(user, pin) {
  if (!user.pinHash) return false;
  return (await hashPin(pin, user.salt)) === user.pinHash;
}

let session = null;   // { userId, siteId }

function loadSession() {
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const u = userById(s.userId);
    if (!u || u.status !== "active") return null;
    return s;
  } catch (_) { return null; }
}
const saveSession = () => storage.setItem(SESSION_KEY, JSON.stringify(session));
const clearSession = () => { session = null; storage.removeItem(SESSION_KEY); };

const currentUser = () => (session ? userById(session.userId) : null);
const isAdmin = () => { const u = currentUser(); return !!u && u.role === "admin"; };

// An account is only usable if it is active AND has a PIN. Accounts restored
// from a v1 store have no PIN, so a store can hold users yet still have nobody
// able to sign in — that must route to setup, not to a dead login form.
const canSignIn = (u) => !!u && u.status === "active" && !!u.pinHash;
const usableUsers = () => db.users.filter(canSignIn);

// Site the session is acting on. Admins may scope to "" (all sites).
const currentSiteId = () => (session ? session.siteId || "" : "");

/* ------------------------------------------------------------
   Queries
   ------------------------------------------------------------ */
const siteById = (id) => db.sites.find((s) => s.id === id) || null;
const siteName = (id) => (siteById(id) || {}).name || "—";
const userById = (id) => db.users.find((u) => u.id === id) || null;
const activeSites = () => db.sites.filter((s) => s.status === "active");
const agentUsers = () => db.users.filter((u) => u.role === "agent");

const sitesForUser = (u) => {
  if (!u) return [];
  if (u.role === "admin") return db.sites.slice();
  return db.sites.filter((s) => (u.siteIds || []).includes(s.id));
};

const inSite = (rec, siteId) => !siteId || rec.siteId === siteId;

const stockOf = (type, siteId) =>
  db.vouchers.filter((v) => v.type === type && v.status === "available" && inSite(v, siteId)).length;
const soldOf = (type, siteId) =>
  db.vouchers.filter((v) => v.type === type && v.status === "sold" && inSite(v, siteId)).length;

const salesInScope = (siteId) => db.sales.filter((s) => inSite(s, siteId));

/* --- credit ------------------------------------------------- */

// saleId → amount already paid (rebuilt only when the store changes)
let _paidCache = { rev: -1, map: new Map() };
function paidMap() {
  if (_paidCache.rev !== _rev) {
    const m = new Map();
    for (const p of db.payments) {
      for (const a of p.allocations || []) m.set(a.saleId, (m.get(a.saleId) || 0) + a.amount);
    }
    _paidCache = { rev: _rev, map: m };
  }
  return _paidCache.map;
}

const saleOutstanding = (sale) =>
  sale.pay === "credit" ? Math.max(0, sale.price - (paidMap().get(sale.id) || 0)) : 0;

const accountById = (id) => db.accounts.find((a) => a.id === id) || null;

const accountOpenSales = (accountId) => db.sales
  .filter((s) => s.accountId === accountId && s.pay === "credit" && saleOutstanding(s) > 0)
  .sort((a, b) => a.soldAt.localeCompare(b.soldAt));

const accountBalance = (accountId) =>
  accountOpenSales(accountId).reduce((sum, s) => sum + saleOutstanding(s), 0);

const accountPayments = (accountId) => db.payments
  .filter((p) => p.accountId === accountId)
  .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

const accountsInScope = (siteId) => db.accounts.filter((a) => inSite(a, siteId));

const openAccounts = (siteId) => accountsInScope(siteId)
  .map((a) => ({ account: a, balance: accountBalance(a.id) }))
  .filter((x) => x.balance > 0)
  .sort((x, y) => y.balance - x.balance);

const totalOutstanding = (siteId) =>
  accountsInScope(siteId).reduce((sum, a) => sum + accountBalance(a.id), 0);

const accountKey = (name, phone) =>
  `${String(name).trim().toLowerCase()}|${String(phone || "").replace(/\D/g, "")}`;

function findOrCreateAccount(name, phone, siteId) {
  const key = accountKey(name, phone);
  const found = db.accounts.find((a) => a.siteId === siteId && accountKey(a.name, a.phone) === key);
  if (found) return found;
  const acc = {
    id: newId(), name: String(name).trim(), phone: String(phone || "").trim(),
    siteId, createdAt: new Date().toISOString(),
  };
  db.accounts.push(acc);
  touch("accounts", acc);
  return acc;
}

// Applies a payment oldest-debt-first. Returns the stored payment record.
function recordPayment(accountId, amount, method, note, userId) {
  const balance = accountBalance(accountId);
  let remaining = Math.min(Number(amount), balance);
  if (!(remaining > 0)) return null;
  const allocations = [];
  for (const sale of accountOpenSales(accountId)) {
    if (remaining <= 0) break;
    const owed = saleOutstanding(sale);
    const pay = Math.min(owed, remaining);
    allocations.push({ saleId: sale.id, amount: pay });
    remaining -= pay;
  }
  const user = userById(userId);
  const payment = {
    id: newId(), accountId,
    amount: allocations.reduce((s, a) => s + a.amount, 0),
    method, note: String(note || "").trim(),
    receivedBy: userId, receivedByName: user ? user.name : "—",
    receivedAt: new Date().toISOString(),
    allocations,
  };
  db.payments.push(payment);
  touch("payments", payment);
  save();
  return payment;
}

/* --- periods & closing reports ------------------------------- */

function periodRange(period) {
  const [y, m] = String(period).split("-").map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}
function inPeriod(iso, period) {
  const { start, end } = periodRange(period);
  const d = new Date(iso);
  return d >= start && d < end;
}

const closingFor = (userId, period, siteId) => db.closings.find((c) =>
  c.userId === userId && c.period === period && (c.siteId || "") === (siteId || "")) || null;

// The month-end picture for one operator (or all, when userId is null).
function buildReport(userId, period, siteId) {
  const sales = db.sales.filter((s) =>
    (!userId || s.agentId === userId) && inSite(s, siteId) && inPeriod(s.soldAt, period));
  const payments = db.payments.filter((p) =>
    (!userId || p.receivedBy === userId) && inPeriod(p.receivedAt, period) &&
    (!siteId || (accountById(p.accountId) || {}).siteId === siteId));

  const cashSales = sales.filter((s) => s.pay === "cash");
  const creditSales = sales.filter((s) => s.pay === "credit");

  const cashSalesTotal = cashSales.reduce((sum, s) => sum + s.price, 0);
  const creditIssued = creditSales.reduce((sum, s) => sum + s.price, 0);
  const debtCollected = payments.reduce((sum, p) => sum + p.amount, 0);
  // How much of this period's own credit is still unpaid, as of now.
  const unpaidFromPeriod = creditSales.reduce((sum, s) => sum + saleOutstanding(s), 0);

  const byType = {};
  for (const t of TYPE_ORDER) {
    const rows = sales.filter((s) => s.type === t);
    byType[t] = { count: rows.length, total: rows.reduce((sum, s) => sum + s.price, 0) };
  }
  const byMethod = {};
  for (const m of Object.keys(PAY_METHODS)) {
    byMethod[m] = payments.filter((p) => p.method === m).reduce((sum, p) => sum + p.amount, 0);
  }

  return {
    period, userId: userId || null, siteId: siteId || "",
    salesCount: sales.length,
    cashCount: cashSales.length, cashSalesTotal,
    creditCount: creditSales.length, creditIssued,
    paymentsCount: payments.length, debtCollected,
    totalCashCollected: cashSalesTotal + debtCollected,
    unpaidFromPeriod,
    outstandingNow: totalOutstanding(siteId),
    byType, byMethod,
  };
}

/* ------------------------------------------------------------
   Toasts & dialogs
   ------------------------------------------------------------ */
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 350);
  }, 3600);
}

function confirmDlg(message) {
  return new Promise((resolve) => {
    const modal = $("#modal-confirm");
    $("#confirm-msg").textContent = message;
    modal.hidden = false;
    const done = (val) => {
      modal.hidden = true;
      $("#confirm-yes").onclick = $("#confirm-no").onclick = modal.onclick = null;
      resolve(val);
    };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

/* ------------------------------------------------------------
   Chips
   ------------------------------------------------------------ */
const typeChip = (type) => {
  const t = VTYPES[type] || { label: type, chip: "" };
  return `<span class="chip ${t.chip}"><i></i>${t.label}</span>`;
};
const payChip = (pay) => pay === "cash"
  ? `<span class="chip chip-cash"><i></i>CASH</span>`
  : `<span class="chip chip-credit"><i></i>CREDIT</span>`;
const roleChip = (role) => role === "admin"
  ? `<span class="chip chip-admin"><i></i>ADMIN</span>`
  : `<span class="chip chip-agent"><i></i>AGENT</span>`;
const statusChip = (status) => status === "active"
  ? `<span class="chip chip-ok"><i></i>ACTIVE</span>`
  : `<span class="chip chip-off"><i></i>INACTIVE</span>`;

/* ------------------------------------------------------------
   CSV
   ------------------------------------------------------------ */
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s;     // spreadsheet-injection guard
  return `"${s.replace(/"/g, '""')}"`;
}
function downloadCSV(filename, rows) {
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

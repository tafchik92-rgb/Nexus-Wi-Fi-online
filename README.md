# NEXUS//POS — Wi-Fi Shop Point-of-Sale

A dynamic, sci-fi-styled point-of-sale platform for a multi-site Wi-Fi voucher
business. **Zero dependencies, no build step, no server** — a handful of static
files that run anywhere a browser runs. All data persists in `localStorage`.

## ✨ Features

### Access control
Staff sign in with a **staff code + PIN**. Two roles:

| | Administrator | Sales agent |
|---|---|---|
| Dashboard, sales ledger, CSV export | ✅ | — |
| Team & site management | ✅ | — |
| Voucher upload / import | ✅ | — |
| Credit oversight | all sites | own site |
| Sales terminal | ✅ | ✅ |
| Settle customer debts | ✅ | ✅ |
| Month-end closing | all agents | own only |

PINs are salted and hashed (SHA-256 via SubtleCrypto, with a non-cryptographic
fallback where it is unavailable). **This is a UI-level role gate, not a security
boundary** — the app is browser-only, so anyone with devtools can read or edit
`localStorage`. Point `load`/`save` in `core.js` at a real backend if you need
enforced authorization.

### Multi-location management
Open any number of **sites**; vouchers, sales, staff assignments and credit
accounts are all scoped per site. Voucher uploads (paste, generate, or file
import) allocate stock to a chosen site — the same code may exist at two shops
without colliding. Admins switch scope (or view **ALL SITES**) from the header;
agents are locked to their assignment.

### Credit tracking & settlement
- A credit sale books debt against a **customer account** (matched by name +
  contact within a site) instead of taking cash.
- The terminal warns when a customer already owes money, with a **settle now**
  shortcut.
- **Settlement workflow**: record a full or partial payment (cash, mobile money,
  bank transfer) with an optional reference. Payments clear the **oldest unpaid
  voucher first**, over-payment is capped at the balance, and a receipt shows
  the remaining balance.
- **Credit accounts view** lists every open account with balance, debt age and
  last payment, plus a per-customer **statement** of unpaid vouchers and payment
  history. Admins additionally get a full settlement history across sites.

### Month-end reporting
Agents close their own month; admins see every agent for the period.
The statement breaks down **total cash collected vs outstanding debt**:

```
Cash sales                     +   count / amount
Debt settlements received      +   count / amount
─────────────────────────────────────────────────
TOTAL CASH COLLECTED           =   amount
Credit issued                      count / amount
STILL OUTSTANDING                  amount
```

…plus per-voucher-group volumes and settlements by method. **Closing the month
freezes the totals** into a closing record; CSV export works open or closed.

### Voucher stock
Bulk upload by pasting codes, auto-generating unique ones, or **importing
hotspot exports** (`.xlsx` / `.csv` — e.g. TP-Link Omada `VoucherList` files:
codes from the *Code* column, group auto-detected from *Price*). Duplicate
detection, batch tracking and per-group stock meters throughout.

## 🚀 Run it

```bash
# option 1 — just open it
open index.html

# option 2 — any static server
npx serve .                # or: python3 -m http.server
```

Deploys as-is to GitHub Pages, Netlify, Firebase Hosting or any static host.

**First run:** with no staff on file the app opens a **first-run setup** screen —
create the administrator who will run the shop (code + PIN) and name your first
site, and you are signed straight in.

**Demo shop:** press **LOAD THE DEMO SHOP** on that screen (or open
`index.html?demo=1`) for two sites, four staff accounts, six weeks of trading,
and a mix of settled and outstanding credit:

| Account | Code | PIN |
|---|---|---|
| Ada Mensah — administrator | `ADM-01` | `1234` |
| Kira Vance — agent, Gloy Mine Camp | `AG-01` | `1111` |
| Dex Moreau — agent, Gloy Mine Camp | `AG-02` | `2222` |
| Zara Chen — agent, Riverside Kiosk | `AG-03` | `3333` |

Change PINs from the **⚿ PIN** button; admins can reset any staff PIN.

## 🗂 Data model (`localStorage` key `nexuspos.v2`)

```js
site    { id, name, code, status, createdAt }
user    { id, name, code, role: "admin"|"agent", salt, pinHash, siteIds[], status }
voucher { id, code, type: "V5"|"V10"|"REC", siteId, status, batch, uploadedAt }
account { id, name, phone, siteId, createdAt }
sale    { id, customer, phone, accountId, voucherId, voucherCode, type, price,
          pay: "cash"|"credit", agentId, agentName, siteId, soldAt /* auto */ }
payment { id, accountId, amount, method, note, receivedBy, receivedAt,
          allocations: [{ saleId, amount }] }
closing { id, userId, siteId, period: "YYYY-MM", generatedAt, totals }
```

A v1 store is migrated automatically into a single "Main Shop" site.
Balances are derived from payment allocations — never stored — so a sale's
outstanding amount is always `price − allocated`.

## 📁 Files

| File | Role |
|---|---|
| `index.html` | login screen, app shell, all views and modals |
| `styles.css` | the sci-fi design system |
| `core.js` | storage, data model, auth, queries, formatting |
| `admin.js` | dashboard, team, sites, vouchers, credit oversight, reports |
| `agent.js` | terminal, credit accounts, settlement, month-end |
| `app.js` | boot, login, routing, wiring, demo data |
| `importer.js` | dependency-free `.xlsx` / `.csv` voucher reader |

## 🎨 Design notes

- Dark-only sci-fi system: cut-corner glass panels, neon cyan/magenta accents,
  animated grid + glow ambience. Honors `prefers-reduced-motion`.
- Chart series colors (`#1aa3c9` / `#c2841c` / `#c9569e` on `#0d131f`) are
  validated for color-vision-deficiency separation and ≥3:1 surface contrast;
  the stacked cash-flow chart carries a legend so color never encodes alone.
- CSV exports quote every field and guard against formula injection.

## ⚠️ Scope

Front-end only: no server, no enforced authorization, and data lives in the
browser profile that created it. Multiple tills do **not** share a ledger. To
run a real multi-till shop, wire `load`/`save` in `core.js` to an API or a
service like Firebase and move the role checks server-side.

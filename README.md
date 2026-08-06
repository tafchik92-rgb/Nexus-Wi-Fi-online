# NEXUS//POS — Wi-Fi Shop Point-of-Sale

A dynamic, sci-fi-styled point-of-sale platform for a multi-site Wi-Fi voucher
business. The front end is a handful of dependency-free static files; the shop
itself — staff, stock, sales, debts — lives in **one shared Firebase project**,
so the desk, the phone and the tablet always agree. Setup is in
**[BACKEND.md](BACKEND.md)**.

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

This is enforced server-side, not in the browser: the PIN is verified by a Cloud
Function against a salted scrypt hash no client can read, and the token it mints
carries role and site claims that the Firestore security rules read directly.
Editing anything in devtools widens nothing. See **[BACKEND.md](BACKEND.md)**.

### Multi-location management
Open any number of **sites**; vouchers, sales, staff assignments and credit
accounts are all scoped per site. Sites can be **renamed** at any time — records
reference a site by id, so past sales, vouchers, credit accounts and closed
reports all follow the new name. Voucher uploads (paste, generate, or file
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

### Reversing a sale
A network fault that bills a customer twice needs undoing, and an
administrator can do it from the ledger — but a sale is never edited or
deleted. The reversal is appended alongside it, so the row stays visible,
struck through, with the reason and who reversed it. Takings, debts, reports
and the agent's own day all stop counting it.

The code then either **returns to stock** (nobody received it) or is **voided**
(the customer has it, so it must never be sold again). Reversals are keyed by
the sale, so one sale can be reversed exactly once no matter how many tills
try. Money already collected is reported before you confirm — reversing clears
the debt, it does not hand the cash back.

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

Stock is removed the same way it arrives — in bulk. Filter the vault by site,
group, status or **upload batch**, and **PURGE** deletes every unsold voucher
in view. Sold vouchers are never deletable: they are the record of a sale, and
the security rules refuse it regardless of what the client asks.

## 📱 Install on a phone

The app is installable. Sign-in screen and header both carry an **⤓ INSTALL**
button: on Chrome/Edge/Android it fires the browser's own install prompt, and
on iOS — which has no such prompt — it explains the Share → Add to Home Screen
route. Either way the till then launches full screen with its own icon, and a
service worker caches the app shell so it opens instantly.

Installation needs **HTTPS** and a real browser tab. An embedded preview frame
cannot install, which is the usual reason the button does nothing.

Reading works from cache through a brief drop. **Issuing a code does not** — see
*Why selling needs a connection* below.

Installation needs HTTPS (or `localhost`), so deploy it — Firebase Hosting,
Netlify or GitHub Pages all qualify.

## 🚀 Run it

```bash
# option 1 — just open it
open index.html

# option 2 — any static server
npx serve .                # or: python3 -m http.server
```

Deploys as-is to GitHub Pages, Netlify, Firebase Hosting or any static host.

**Deploy the backend first** (`bash deploy.sh`) — the app has nothing to talk to
otherwise. Fill in `firebase-config.js` and every till connects on load; leave it
blank and the first screen asks for the config.

**First run:** on a project with no staff, choose **set up a new shop** on the
sign-in screen. That creates the founding administrator (code + PIN) and your
first site on the server, and signs you in. It refuses to run once any staff
exist, so it cannot be replayed.

Change PINs from the **⚿ PIN** button; admins can reset any staff PIN from
**Team → RESET PIN**.

## 🗂 Data model (Firestore collections)

```js
site    { id, name, code, status, createdAt }
staff   { id, name, code, role: "admin"|"agent", siteIds[], status, createdAt }
staffAuth { salt, hash, algo, failedAttempts, lockedUntil }   ← no client access
voucher { id, code, type: "V5"|"V10"|"REC", siteId, status, batch, uploadedAt, soldAt }
account { id, name, phone, siteId, createdAt }
sale    { id, customer, phone, accountId, voucherId, voucherCode, type, price,
          pay: "cash"|"credit", agentId, agentName, siteId, soldAt /* auto */ }
payment { id, accountId, siteId, amount, method, note, receivedBy, receivedAt,
          allocations: [{ saleId, amount }] }
closing { id, userId, siteId, period: "YYYY-MM", generatedAt, totals }
```

PIN material lives in a separate `staffAuth` collection that **no client can
read or write** — only the Cloud Functions reach it. Balances are derived from
payment allocations, never stored, so a sale's outstanding amount is always
`price − allocated`.

## 📁 Files

| File | Role |
|---|---|
| `index.html` | login screen, app shell, all views and modals |
| `styles.css` | the sci-fi design system |
| `core.js` | data model, session, queries, formatting |
| `admin.js` | dashboard, team, sites, vouchers, credit oversight, reports |
| `agent.js` | terminal, credit accounts, settlement, month-end |
| `app.js` | boot, login, routing, wiring |
| `backend.js` | Firebase adapter: sync, sign-in, the transactional voucher claim |
| `functions/` | Cloud Functions — PIN checks, staff provisioning, role claims |
| `firestore.rules` | the authorization boundary |
| `importer.js` | dependency-free `.xlsx` / `.csv` voucher reader |

## 📐 Layout across form factors

Audited at 320, 390, 430, 768, 1024, 1280 and 1920px, as both an administrator
and an agent, across every screen and modal. `tests/responsive.test.mjs` keeps
it that way — it fails on content wider than the screen with no scroller,
controls pushed off an edge, zero-sized controls, tap targets under 28×24, or
text clipped with nowhere to scroll.

The fault worth knowing about: grid and flex children are `min-width: auto` by
default, so one wide table sized its whole column — and every sibling — to the
table. With overflow clipped at the root that content was not scrolled to, it
was unreachable. On a 390px phone the staff form measured 1109px with CREATE
ACCOUNT some 700px off the right edge.

## 🎨 Design notes

- Dark-only sci-fi system: cut-corner glass panels, neon cyan/magenta accents,
  animated grid + glow ambience. Honors `prefers-reduced-motion`.
- Chart series colors (`#1aa3c9` / `#c2841c` / `#c9569e` on `#0d131f`) are
  validated for color-vision-deficiency separation and ≥3:1 surface contrast;
  the stacked cash-flow chart carries a legend so color never encodes alone.
- CSV exports quote every field and guard against formula injection.

## 🔌 Why selling needs a connection

A voucher code may be handed out exactly once. Two tills trading offline would
each pick from their own idea of what is still in stock, and sooner or later
hand the same code to two customers — which nobody notices until a customer
complains or the month-end numbers disagree.

So the till claims stock inside a **Firestore transaction**: the server re-reads
the voucher before committing, flips it from `available` to `sold`, and writes
the sale in the same commit. When two tills reach for the last code the server
picks a winner; the loser silently takes the next one. That is a guarantee no
amount of client-side cleverness can provide offline, so the till does not
pretend otherwise.

The header badge always says where things stand:

| Badge | Meaning |
|---|---|
| **☁ SHARED SHOP** | Connected — every till sees the same stock and sales |
| **☁ NO CONNECTION** | Reports still read from cache; a code cannot be issued |
| **☁ SYNC ERROR** | The database refused the connection — run diagnostics |

With no link, pressing **COMPLETE SALE** fails immediately and says *"Nothing was
charged"* — nothing is written, and no code is burned. Settlements and account
edits do queue and sync later, because a payment races with nothing.

## ☁️ Backend

**[▸ Deploy in Cloud Shell](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Ftafchik92-rgb%2FNexus-Wi-Fi-online&cloudshell_workspace=.&cloudshell_open_in_editor=deploy.sh)** → then run `bash deploy.sh`

- **Auth**: the `signIn` Cloud Function checks the PIN (scrypt, salted,
  rate-limited with a 5-attempt lockout) and mints a token carrying role + site
  claims. PINs never reach the browser.
- **Authorization**: Firestore rules — cross-site reads denied, prices pinned to
  the voucher group, sales and payments append-only, a voucher only ever going
  `available → sold` once, PIN material unreachable by every client.
- **Sessions**: held by Firebase Auth, so a refresh mid-shift does not ask for a
  PIN again — but the token, and the claims the rules read, still come from the
  server.
- **Migration**: a till that traded on an older device-only build can push its
  history up from **Admin → CLOUD**.

- **Scoped sync**: an agent's listeners are narrowed to their own sites, which
  is what the rules allow. An unscoped listen is refused outright, and
  Firestore would then serve the previous user's cached documents — so signing
  out clears the cache too.

Tested against the Firebase emulators: **43 security-rules checks** and **21
server-side auth and selling checks** (`tests/`), including claiming a whole
pool of vouchers and asserting every code came out exactly once, and that an
agent can read their own site's settlements but not a neighbouring site's.

## ⚠️ Scope

The shop cannot run without its Firebase backend — that is the point, and
`BACKEND.md` covers deploying it. Cloud Functions need the Blaze plan; a shop of
this size sits inside the free monthly allowance.

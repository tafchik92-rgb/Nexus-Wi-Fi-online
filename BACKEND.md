# NEXUS//POS — backend setup

There is one shop and it lives on the server. Every till — the desk, the
phone, the tablet — reads and writes the same Firestore project, so stock and
takings are the same everywhere. There is no device-only mode: the app does not
work until this backend is deployed.

| | |
|---|---|
| Data | Firestore, shared by every till |
| Auth | PIN verified by a Cloud Function, never in the browser |
| Authorization | Firestore security rules, from token claims |
| Offline | reads keep working from cache; **selling needs a connection** |

Selling requires the link on purpose. A voucher code may only be handed out
once, and two tills guessing offline would eventually hand out the same one.
The till says so plainly and charges nothing rather than issue a code it cannot
prove is still available.

---

## What the server actually enforces

The browser is treated as hostile. Three things make that real:

1. **PINs never leave the server.** `staffAuth/` holds a salted **scrypt** hash and
   is unreadable and unwritable by *every* client — admins included. Only the
   `signIn` function (Admin SDK) can check a PIN, and five wrong attempts lock
   the account for five minutes.
2. **Role and site scope live in the token.** `signIn` mints a custom token whose
   claims carry `role` and `siteIds`. The rules read those claims, so a client
   cannot widen its own access by editing anything locally.
3. **The ledger is append-only.** Sales and payments cannot be edited or deleted
   by anyone, prices are pinned to the voucher group in the rules, and a sale
   must be booked to the staff member making it.
4. **A voucher can only go from available to sold, once.** The rules refuse any
   other transition, and refuse to let a claim rewrite the code, group or site.
   The till claims stock inside a Firestore transaction, so when two tills reach
   for the last code the server picks a winner and the loser takes the next one.

---

## 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**.
2. **Build → Firestore Database → Create database** (production mode; pick a
   region close to your shops).
3. **Build → Authentication → Get started** and enable **Anonymous**.
   *(Custom-token sign-in needs the Auth service switched on; staff never see an
   anonymous login — the app only uses server-minted tokens.)*
4. **Project settings → Your apps → Web (`</>`)** → register an app → copy the
   `firebaseConfig` object. You will paste it into the app in step 4.

Cloud Functions require the **Blaze** (pay-as-you-go) plan. A shop of this size
sits inside the free monthly allowance; set a budget alert if you want a cap.

## 2. Deploy in one command (Cloud Shell)

**[▸ Open this repo in Google Cloud Shell](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Ftafchik92-rgb%2FNexus-Wi-Fi-online&cloudshell_workspace=.&cloudshell_open_in_editor=deploy.sh)**

Cloud Shell is a browser terminal already signed in as you, so there are no keys
to copy and nothing to paste. Once it opens:

```bash
bash deploy.sh
```

That enables the required Google Cloud APIs, installs the function
dependencies, and deploys the rules, indexes and functions. Options:
`--rules-only` for just the security rules, `--with-hosting` to build and
publish the web app too. Re-running it is safe.

*The one-click link clones over HTTPS, so a **private** repo will ask Cloud
Shell to authenticate to GitHub. Either make the repo public (it holds no
secrets — the Firebase web config is public by design and the deploy key lives
in GitHub Actions) or clone it yourself in Cloud Shell first.*

Nothing can deploy with **no** authentication at all: publishing rules changes
who may read your shop's data, so Google requires an authenticated admin. Cloud
Shell removes the credential handling, not the sign-in.

## 3. Or install the tooling locally

```bash
npm install -g firebase-tools
firebase login
cd nexus-wifi-pos
firebase use --add            # pick the project, alias it "default"
cd functions && npm install && cd ..
```

## 4. Deploy rules, indexes and functions

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Deploy the **rules before** letting staff in — an open database is the one
mistake this whole design exists to prevent.

Optionally host the app itself. This repo is also an AI Studio / Vite project,
so build first and deploy `dist/`:

```bash
npm install
npm run build          # copies the plain scripts into dist/ (see vite.config.ts)
firebase deploy --only hosting
```

Point `hosting.public` in `firebase.json` at `dist` if you deploy the built
output; leave it at `.` if you deploy the plain static files as-is.

## 5. Point the app at the project

Two ways:

- **For every device at once (recommended):** fill in **`firebase-config.js`**
  and redeploy. Every till that loads the page is then connected with nothing
  to configure.
- **Per device:** leave it blank and the first screen asks for the config. Paste
  it exactly as the console shows it — the `const firebaseConfig = { … };`
  JavaScript form is accepted, unquoted keys and all; it does not need
  converting to JSON. Admin → **CLOUD** repoints a till later.

If your Firestore is a **named** database rather than `(default)`, set
`firestoreDatabaseId` in `firebase-config.js`, `firestore.database` in
`firebase.json`, and `PROD_DATABASE_ID` in `functions/index.js` to match.
Connecting to the wrong one does not error — it simply times out.

Do **not** hand-add a `<script type="module">` Firebase snippet to `index.html`.
`backend.js` initializes the SDK itself — with the read cache, emulator wiring
and auth the POS needs — and a module's `import` is scoped away from the app's
other scripts, which share globals.

A brand-new project has no staff, so the login screen offers **set up a new
shop**, which calls `bootstrap` to create the founding administrator and first
site. `bootstrap` refuses to run once any staff exist, so it cannot be replayed.

## 6. Move older records across

For a till that traded on an earlier, device-only build of this app:
**Admin → CLOUD → PUSH LOCAL DATA TO THE SHOP** uploads that browser's sites,
vouchers, accounts, sales, payments and closings. Records keep their ids, so
pushing twice updates rather than duplicates. Do it from each device that has
history worth keeping.

**Staff PINs are deliberately not migrated** — the old local hashes were never
meant to leave the device. Imported agents arrive with a fresh random PIN;
reset each from **Team → RESET PIN** and hand it out.

---

## What happens when the link drops

Firestore's cache keeps serving reads, so reports, credit accounts and the
day's log stay on screen and the app does not go blank. The header chip flips
to **NO CONNECTION**.

Issuing a code stops. `Backend.claimAndSell` runs a Firestore transaction,
which cannot be queued offline — it either commits against live server state or
fails. The agent sees *"No connection to the shop — a code can only be issued
online. Nothing was charged."* and nothing is written.

That is the trade the design makes: a shop that occasionally has to wait for a
signal, rather than one that quietly sells the same voucher twice and finds out
at month end.

Settlements and account edits are ordinary writes and do queue, because they
race with nothing — a payment against an account is safe to apply late.

---

## Automated deploys (recommended)

`.github/workflows/firebase-deploy.yml` deploys on every push that touches the
rules, indexes or functions — and **refuses to deploy unless both emulator
suites pass first**, so a broken rule can never reach the live shop.

Credentials stay in GitHub's secret store. Nobody pastes a key into a chat, an
issue or a config file, and a service account scoped to this one project is far
safer than a `firebase login:ci` token (which grants access to *every* project
on your account).

**One-time setup:**

1. Create the service account and grant it only what deploying needs:

   ```bash
   PROJECT=your-firebase-project-id

   gcloud iam service-accounts create nexus-pos-deployer \
     --display-name="NEXUS//POS CI deployer" --project "$PROJECT"

   SA="nexus-pos-deployer@$PROJECT.iam.gserviceaccount.com"
   for ROLE in roles/firebaserules.admin roles/cloudfunctions.admin \
               roles/firebasehosting.admin roles/iam.serviceAccountUser \
               roles/artifactregistry.admin roles/serviceusage.serviceUsageConsumer \
               roles/datastore.indexAdmin; do
     gcloud projects add-iam-policy-binding "$PROJECT" \
       --member="serviceAccount:$SA" --role="$ROLE" --condition=None
   done

   gcloud iam service-accounts keys create key.json \
     --iam-account "$SA" --project "$PROJECT"
   ```

   *(No `gcloud`? Firebase console → Project settings → Service accounts →
   Generate new private key gives you an equivalent `key.json`.)*

2. In GitHub → **Settings → Secrets and variables → Actions**:
   - **Secrets → New repository secret** → name `FIREBASE_SERVICE_ACCOUNT`,
     value = the entire contents of `key.json`.
   - **Variables → New repository variable** → name `FIREBASE_PROJECT_ID`,
     value = your project id.

3. **Delete `key.json` from your machine** — GitHub now holds the only copy.
   Rotate it from the console if it is ever exposed.

Then push, or run **Actions → Deploy to Firebase → Run workflow** to deploy on
demand. The workflow uses a `production` environment, so adding required
reviewers there gives you a manual approval gate.

---

## Tests

Both suites run against the emulators — no cloud project, no cost.

```bash
# terminal 1
firebase emulators:start --only firestore,functions,auth --project nexus-pos-fn-test

# terminal 2
cd tests && npm install
node tests/rules.test.mjs          # 43 authorization checks
node tests/functions.test.mjs      # 21 server-side auth + selling checks
node tests/reversal.test.mjs       # 12 checks, needs a static server too
```

A third suite audits the layout. It needs Playwright and the app on a static
server, and it drives every screen as both roles at seven form factors —
320px phone through 1920px desktop — failing on anything a person could not
reach: content wider than the screen with no scroller, controls pushed off an
edge, zero-sized controls, tap targets under 28x24, and text clipped with no
ellipsis. Decorative layers are exempt, being aria-hidden and unclickable.

```bash
npx serve -l 4199 .                # terminal 3
node tests/responsive.test.mjs     # exits non-zero on any finding
```

`rules.test.mjs` asserts the boundary: cross-site reads, forged sales, price
tampering, ledger edits, reselling a sold voucher and PIN-material access are
all denied — including the exact transaction the till uses to claim a code and
book its sale together. `functions.test.mjs` covers bootstrap replay, PIN
storage, lockout and role checks, then claims a whole pool of vouchers and
asserts every code came out exactly once.

Under the emulator the functions fall back to the `(default)` database
(`FUNCTIONS_EMULATOR`), since an emulated project has only that one.

---

## Data model

```
sites/{id}       name, code, status, createdAt
staff/{id}       name, code, role, siteIds[], status, createdAt
staffAuth/{id}   salt, hash, algo, failedAttempts, lockedUntil    ← no client access
vouchers/{id}    code, type, siteId, status, batch, uploadedAt, soldAt
accounts/{id}    name, phone, siteId, createdAt
sales/{id}       customer, phone, accountId, voucherId, voucherCode, type,
                 price, pay, agentId, agentName, siteId, soldAt      ← immutable
reversals/{saleId}  saleId, siteId, voucherId, voucherCode, amount, pay,
                 paidAtReversal, outcome, reason, reversedBy,
                 reversedByName, reversedAt                          ← immutable
payments/{id}    accountId, siteId, amount, method, note, receivedBy,
                 receivedAt, allocations[{saleId, amount}]           ← immutable
closings/{id}    userId, siteId, period, generatedAt, totals
```

Balances are never stored — a sale's outstanding amount is always
`price − allocated`, derived from payment allocations.

**Reversing a sale never edits or deletes it.** A reversal is appended to
`reversals/`, keyed by the sale's own id so a sale can be reversed exactly
once — two administrators on different tills cannot both undo the same sale
and disagree about what became of the code. The reversal and the voucher move
in one transaction, so a dropped connection cannot restore stock without
recording why. Everything that counts money asks whether a sale still stands;
the ledger still shows it, struck through, with the reason and who did it.

A voucher can come back as `available` (nobody received the code) or `void`
(the customer has it, so it must never be sold again). Voided codes leave
stock permanently and are excluded from every count.

`payments.siteId` is a copy of its account's site. It has to be on the payment
itself: the rules can look an account up for a single document read, but not
for a query, so without it an agent cannot list settlements at all — and a
balance computed without them tells the agent a customer still owes money they
have already handed over. Settlements written before this carry no site;
**Admin → CLOUD** offers to stamp them, which is the one edit the rules permit
on an otherwise immutable record.

## What each staff member syncs

Listening to a whole collection only works if *every* document in it is
readable, so only an admin can. An agent's listeners are scoped to match the
rules exactly, using the same token claims the rules read:

| Collection | Admin | Agent |
|---|---|---|
| `sites`, `staff` | all | all — every till needs them |
| `vouchers`, `accounts`, `sales`, `payments` | all | `where siteId in (their sites)` |
| `closings` | all | `where userId == them` |

Getting this wrong is not a quiet failure: an unscoped listen is refused
outright, the header shows **SYNC ERROR**, and Firestore then serves whatever
the *previous* user of that device left in its local cache. Signing out now
clears that cache for the same reason.

## Functions

| Function | Who | Purpose |
|---|---|---|
| `bootstrap` | anyone, once | Founding admin + first site; refuses once staff exist |
| `signIn` | anyone | Verifies the PIN, returns a custom token with role + site claims |
| `createStaff` | admin | Creates staff and their PIN hash |
| `changePin` | signed-in | Own PIN, current PIN required |
| `resetPin` | admin | New random PIN, returned once |

Selling is deliberately *not* a function: the till claims a voucher with a
Firestore transaction, checked by the security rules. That keeps the hot path
one round trip instead of two, and leaves the guarantee where it belongs — in
the database, not in code a client could skip.

`createStaff`, `resetPin` and friends re-read the caller's record rather than
trusting the token's role claim, so a demoted admin loses access immediately
instead of when their token expires.

---

## Named Firestore databases

If your project's Firestore is a **named** database rather than `(default)` —
AI Studio provisions one, for example — every part of the stack must be told:

- `firebase-config.js` → `firestoreDatabaseId: "…"` (the client SDK)
- `functions/index.js` → `DATABASE_ID`, overridable with the
  `FIRESTORE_DATABASE_ID` environment variable (the Admin SDK)
- `firebase.json` → `firestore.database` (so rules and indexes deploy there)

Miss any one and it silently talks to a database that does not exist. The
symptom is not an error but a timeout: *"Could not reach Cloud Firestore
backend. Backend didn't respond within 10 seconds."*

## ⚠️ Never deploy open rules

`deploy.sh` refuses to deploy a `firestore.rules` containing
`allow read, write: if true`. That rule set exposes every customer, sale and
debt to anyone who knows the project id — and the project id is public by
design, sitting in the web config. If a tool ever rewrites the rules that way,
restore them with `git checkout firestore.rules`.

## Troubleshooting

**Cloud mode cannot run inside an embedded preview.** AI Studio (and similar
sandboxed previews) allow the page to load scripts from a CDN but block its
outbound `fetch`/XHR. Every Firebase call then fails identically, and the SDK
reports that as a bare `internal`. Diagnostics detects this and says so. The fix
is not a Firebase setting — **open the app in its own browser tab**:

```bash
npm run build && npx firebase-tools deploy --only hosting   # or: npx serve dist
```

**First stop: the app can diagnose itself.** On the cloud login/setup screen
(or Admin → CLOUD) choose **RUN DIAGNOSTICS** — it probes the project from the
browser and names the broken piece: database missing, Authentication off,
functions not deployed, blocked, or crashing. `deploy.sh` runs the same
verification from the server side at the end of every deploy.

**Sign-in or setup fails with `internal`.** A function crashed rather than
returning a real error. The functions now translate the common causes into
plain instructions, so re-deploy first (`bash deploy.sh`) and read the new
message. The usual culprits, in order:

| Cause | Fix |
|---|---|
| Runtime service account cannot sign custom tokens | `deploy.sh` grants **Service Account Token Creator** to `PROJECT_NUMBER-compute@developer.gserviceaccount.com` and enables `iamcredentials.googleapis.com`. This is the most common one — Gen-2 functions do not get it by default. |
| No Firestore database yet | Console → Build → Firestore Database → **Create database** (production mode) |
| Authentication not enabled | Console → Authentication → Get started → enable **Anonymous** |
| Functions not deployed | `bash deploy.sh` — the app calls `bootstrap` and `signIn` by name |

**`databaseURL` in your config is for Realtime Database, a different product.**
This app stores everything in **Cloud Firestore**. The key is harmless if
present, but if you created a Realtime Database expecting it to be the app's
store, create a Firestore database as well (console → Build → Firestore
Database → Create database) — nothing works without it.

To see the real stack behind any failure:

```bash
npx firebase-tools functions:log --only signIn,bootstrap
```

## Cost and limits

- Firestore free tier: 50k reads / 20k writes per day. A shop doing a few
  hundred sales a day sits well inside it.
- The app subscribes to whole collections. Past roughly 50k documents, switch
  the listeners in `backend.js` (`startSync`) to date-bounded queries.
- No PII beyond customer name and phone. Both are visible to staff at that site
  and to admins.

## Limitations, stated plainly

- **The web config is public.** That is normal for Firebase — it identifies the
  project, it does not grant access. Security comes from rules and functions.
- **Local mode has no authorization.** Anyone with devtools can edit
  `localStorage`. Use cloud mode wherever that matters.
- **Deleted sites and staff leave their records behind** (by design — the ledger
  is immutable). Close a site rather than deleting it.

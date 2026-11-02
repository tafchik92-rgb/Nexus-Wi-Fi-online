# Credit Accounts: Deduplication, Ledger System & Balance Filtering

A comprehensive enhancement to the NEXUS//POS Credit Accounts module introducing automated client deduplication and fuzzy-name verification, a complete chronological financial ledger with running balances, and multi-tier balance range filtering.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following user preferences were confirmed during Phase 1 interactive clarification:
> - **Deduplication & Verification Trigger**: Active during both sale checkout (terminal) and inside Credit Accounts oversight.
> - **Client Ledger Presentation**: Built into the customer statement modal as a chronological running-balance transaction ledger with clear debit/credit audit tracking.
> - **Balance Filtering Structure**: Preset balance brackets coupled with custom minimum and maximum amount inputs.

---

## 1. Overview & Core Concept

### What It Delivers
1. **Client Deduplication & Verification**:
   - Automated fuzzy string matching (Levenshtein distance & normalized token comparison) checks customer names against existing accounts at the current site.
   - When issuing credit at checkout, if a similar name exists (e.g., "John Doe" vs "Jon Doe"), an intuitive verification prompt offers to merge with the existing account or proceed as a distinct profile.
   - An explicit "Merge Profiles" tool in Credit Accounts allows administrators and agents to review duplicate candidates and consolidate historical sales and payments cleanly without orphaned records.
2. **Comprehensive Client Ledger System**:
   - Replaces the simple split list in the Customer Statement modal with a full double-entry-style chronological ledger.
   - Shows debit lines (Credit Sales with voucher details), credit lines (Settlement Payments with payment method), and a real-time running balance column.
   - Clearly separates settled amounts vs currently outstanding amounts, with an "Export Ledger CSV" capability for bookkeeping records.
3. **Multi-Tier Balance Filtering**:
   - A dedicated balance filter in the Credit Accounts table supporting preset brackets (`< $10`, `$10–$25`, `$25–$50`, `> $50`) plus inline custom Minimum and Maximum inputs.
   - Fully integrated with the existing debt age, payment date, search query, and table column sorting.

---

## 2. User Experience & Visual Design

### A. Terminal Sale Checkout Verification
- When an operator chooses **CREDIT** and enters a customer name:
  - If an exact match exists, the existing account is used automatically and its outstanding balance is displayed.
  - If a **similar match** is detected (similarity $\ge 80\%$ or edit distance $\le 2$), a subtle inline warning appears under the customer input:
    `⚠ Similar account found: "Ada Mensah" ($20.00 owed). [Use Existing Account] [Keep Separate]`.
  - Upon clicking `Complete Sale`, if unconfirmed, a lightweight confirmation dialog verifies the selection so no duplicate accounts are created accidentally.

### B. Credit Accounts Management & Merging
- In the Credit Accounts table, accounts have a `MERGE` action button next to `STATEMENT` and `SETTLE`.
- Clicking `MERGE` opens a **Merge Client Profiles** modal showing:
  - Source client details and current balance.
  - Target search picker / suggested similar duplicates.
  - Preview of consolidated balance and total combined transactions.
  - A clean confirm button: `⇄ CONFIRM MERGE & REASSIGN RECORDS`.

### C. Enhanced Customer Statement & Ledger Modal
- The statement modal (`#modal-stmt`) is expanded to a high-density, double-entry financial ledger:
  - **Summary Banner**: 4-part KPI strip: `Total Credit Extended`, `Total Settled To Date`, `Current Outstanding Balance`, `Account Age`.
  - **Ledger Table**:
    - `DATE / TIME`: Monospace timestamp.
    - `TRANSACTION`: Badge/chip (`CREDIT SALE`, `SETTLEMENT`, `REVERSAL`).
    - `REFERENCE`: Voucher code or payment note.
    - `DEBIT (+)`: Amount billed to debt (amber/warn text).
    - `CREDIT (-)`: Amount settled (green/ok text).
    - `RUNNING BALANCE`: Real-time computed balance after each event.
    - `AGENT`: Name of operator who handled the transaction.
  - **Actions**: `EXPORT CSV`, `PRINT STATEMENT`, `⇄ SETTLE BALANCE`, and `CLOSE`.

### D. Balance Range Filtering Controls
- Added to the `#credit-filters` and `#ag-credit-filters` bars:
  - Select dropdown: `ALL BALANCES`, `< $10`, `$10 – $25`, `$25 – $50`, `> $50 (HIGH DEBT)`, `CUSTOM RANGE…`
  - When `CUSTOM RANGE` is chosen (or via adjacent compact inputs), `MIN $` and `MAX $` fields appear for precise financial thresholding.
  - Dynamically updates table rows, count badges, and the `↺ RESET FILTERS` button.

---

## 3. Key Product Decisions & Trade-Offs

- **Deterministic In-Memory & Firestore Migration**:
  - *Decision*: When merging two accounts, all past `sales` (where `accountId === oldId`) and `payments` (where `accountId === oldId`) are updated to `newId` with the canonical name, and the duplicate `accounts` document is deleted/retired.
  - *Rationale*: Maintains strict financial integrity so reports, month-end calculations, and agent commissions remain 100% accurate without orphaned debts.
- **Fuzzy Name Matching Algorithm**:
  - *Decision*: Dual-phase comparison: (1) normalized alphanumeric token overlap (handles "John Smith" vs "Smith, John"), and (2) Levenshtein edit-distance threshold for typo tolerance (handles "Amina" vs "Ameena").
  - *Rationale*: Fast, lightweight, pure JavaScript implementation requiring zero external dependencies, running safely in hermetic browsers and offline caches.

---

## 4. Technical Architecture & Data Strategy

### System Component & Data Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                          User Interface                                │
├───────────────────────────────┬────────────────────────────────────────┤
│    Terminal Checkout Flow     │         Credit Accounts View           │
│  - Real-time similarity check │  - Balance Filter (presets + min/max)  │
│  - Verification dialog/action │  - Account list with Age & Balance     │
│                               │  - Merge Profiles Modal               │
└───────────────┬───────────────┴───────────────────┬────────────────────┘
                │                                   │
                ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      Client Ledger & Deduplication                     │
├────────────────────────────────────────────────────────────────────────┤
│  - findSimilarAccounts(name, phone, siteId)                            │
│  - mergeAccounts(targetAccountId, sourceAccountId)                     │
│  - buildAccountLedger(accountId) -> Chronological Event Stream         │
│    (Sales [Debit], Reversals [-Debit], Payments [Credit], Balance)     │
└───────────────┬───────────────────────────────────┬────────────────────┘
                │                                   │
                ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Data Persistence (Firestore + Cache)                 │
├────────────────────────────────────────────────────────────────────────┤
│  - db.accounts: { id, name, phone, siteId, createdAt }                 │
│  - db.sales: { id, accountId, customer, price, pay, ... }              │
│  - db.payments: { id, accountId, amount, allocations, ... }            │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Functions to Implement
1. `core.js`:
   - `stringSimilarity(a, b)`: Normalized Damerau-Levenshtein & token matching.
   - `findSimilarAccounts(name, phone, siteId, excludeId)`: Returns scored matches.
   - `buildAccountLedger(accountId)`: Merges sales, reversals, and payment allocations into a sorted timeline with cumulative running balance.
   - `mergeAccounts(canonicalId, duplicateId)`: Atomically updates matching records in memory and syncs to Firestore via `touch()`.
2. `admin.js` & `agent.js`:
   - `renderAdminCredit()` / `renderAccountsTable()`: Integrates balance range parsing (`all`, `under10`, `10-25`, `25-50`, `over50`, `custom` with `min`/`max`).
   - `openStatement(accountId)`: Renders the complete interactive transaction ledger with running balance, summary tiles, and CSV download.
   - `openMergeModal(accountId)`: Dedicated modal for merging duplicate client profiles.
3. `index.html` & `styles.css`:
   - Add balance filter inputs to `#credit-filters` and `#ag-credit-filters`.
   - Update `#modal-stmt` markup with KPI cards and ledger table structure.
   - Add `#modal-merge` for client deduplication verification.
   - Add responsive styles for custom range fields and ledger debit/credit typography.

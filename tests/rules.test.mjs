/* ============================================================
   Security-rules tests — run against the Firestore emulator.
   These assert the authorization boundary itself: that a hostile
   client cannot read another site's data, forge a sale, rewrite the
   ledger, resell a sold voucher, or reach PIN material.

   Usage:  node tests/run-rules-tests.mjs
   ============================================================ */
import fs from "node:fs";
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, runTransaction,
  query, where,
} from "firebase/firestore";

const SITE_A = "siteA", SITE_B = "siteB";
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", `${name} → ${e.message.split("\n")[0]}`]); }
};

const env = await initializeTestEnvironment({
  projectId: "nexus-pos-rules-test",
  firestore: { rules: fs.readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
});

// Start clean. Sales, payments and closings are create-only by design, so a
// second run against a leftover database would fail on its own fixtures —
// which looks exactly like a broken rule and is not one.
await env.clearFirestore();

// contexts
const admin = env.authenticatedContext("admin1", { role: "admin", siteIds: [] }).firestore();
const agentA = env.authenticatedContext("agentA", { role: "agent", siteIds: [SITE_A] }).firestore();
const agentB = env.authenticatedContext("agentB", { role: "agent", siteIds: [SITE_B] }).firestore();
const anon = env.unauthenticatedContext().firestore();

// Suspended staff still holding the token they were issued while active —
// role and site scope intact, because that is exactly the situation: the
// token is good for up to an hour after an administrator suspends them.
const agentS = env.authenticatedContext("agentS", { role: "agent", siteIds: [SITE_A] }).firestore();
const adminS = env.authenticatedContext("adminS", { role: "admin", siteIds: [] }).firestore();
// A member whose record was deleted outright, token still in hand.
const ghost = env.authenticatedContext("ghost", { role: "agent", siteIds: [SITE_A] }).firestore();

// seed with rules disabled
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, "sites", SITE_A), { name: "Camp", code: "S-01", status: "active" });
  await setDoc(doc(d, "sites", SITE_B), { name: "Kiosk", code: "S-02", status: "active" });
  await setDoc(doc(d, "staff", "agentA"), { name: "A", code: "AG-01", role: "agent", siteIds: [SITE_A], status: "active" });
  await setDoc(doc(d, "staff", "admin1"), { name: "Boss", code: "ADM-01", role: "admin", siteIds: [], status: "active" });
  // agentB's record matters even though every agentB case expects a denial.
  // Without it those writes would be refused for having no staff record at
  // all, and the site scoping they exist to prove would go untested.
  await setDoc(doc(d, "staff", "agentB"), { name: "B", code: "AG-02", role: "agent", siteIds: [SITE_B], status: "active" });
  await setDoc(doc(d, "staff", "agentS"), { name: "S", code: "AG-09", role: "agent", siteIds: [SITE_A], status: "inactive" });
  await setDoc(doc(d, "staff", "adminS"), { name: "ExBoss", code: "ADM-09", role: "admin", siteIds: [], status: "inactive" });
  await setDoc(doc(d, "staffAuth", "agentA"), { hash: "secret", salt: "s" });
  await setDoc(doc(d, "vouchers", "vS-1"), { code: "W5-S", type: "V5", siteId: SITE_A, status: "available", uploadedAt: "2026-08-01T00:00:03Z" });
  await setDoc(doc(d, "vouchers", "vA-1"), { code: "W5-A", type: "V5", siteId: SITE_A, status: "available", uploadedAt: "2026-08-01T00:00:00Z" });
  await setDoc(doc(d, "vouchers", "vA-2"), { code: "W5-B", type: "V5", siteId: SITE_A, status: "available", uploadedAt: "2026-08-01T00:00:01Z" });
  await setDoc(doc(d, "vouchers", "vA-3"), { code: "W5-D", type: "V5", siteId: SITE_A, status: "available", uploadedAt: "2026-08-01T00:00:02Z" });
  await setDoc(doc(d, "vouchers", "vB-1"), { code: "W5-C", type: "V5", siteId: SITE_B, status: "available", uploadedAt: "2026-08-01T00:00:00Z" });
  await setDoc(doc(d, "accounts", "accA"), { name: "Cust", phone: "", siteId: SITE_A });
  await setDoc(doc(d, "accounts", "accB"), { name: "Other", phone: "", siteId: SITE_B });
  await setDoc(doc(d, "sales", "saleA"), { customer: "X", type: "V5", price: 5, pay: "cash", agentId: "agentA", siteId: SITE_A, soldAt: "2026-08-01T00:00:00Z" });
  await setDoc(doc(d, "closings", "clA"), { userId: "agentA", siteId: SITE_A, period: "2026-07", totals: {} });
});

/* ---------------- PIN material is unreachable ---------------- */
await check("nobody can read PIN hashes — not even an admin", async () => {
  await assertFails(getDoc(doc(admin, "staffAuth", "agentA")));
  await assertFails(getDoc(doc(agentA, "staffAuth", "agentA")));
  await assertFails(getDoc(doc(anon, "staffAuth", "agentA")));
});
await check("nobody can write PIN material", async () => {
  await assertFails(setDoc(doc(admin, "staffAuth", "agentA"), { hash: "x" }));
  await assertFails(setDoc(doc(agentA, "staffAuth", "agentA"), { hash: "x" }));
});

/* ---------------- unauthenticated is locked out ---------------- */
await check("signed-out clients read nothing", async () => {
  await assertFails(getDocs(collection(anon, "sales")));
  await assertFails(getDoc(doc(anon, "sites", SITE_A)));
  await assertFails(getDoc(doc(anon, "vouchers", "vA-free")));
});

/* ---------------- role escalation ---------------- */
await check("an agent cannot create staff or grant itself admin", async () => {
  await assertFails(setDoc(doc(agentA, "staff", "newguy"), { name: "M", code: "X", role: "admin", status: "active", siteIds: [] }));
  await assertFails(updateDoc(doc(agentA, "staff", "agentA"), { role: "admin" }));
});
await check("even an admin cannot create staff directly (functions only)", async () => {
  await assertFails(setDoc(doc(admin, "staff", "newguy2"), { name: "M", code: "Y", role: "agent", status: "active", siteIds: [] }));
});
await check("an admin can suspend staff but not rewrite their code", async () => {
  await assertSucceeds(updateDoc(doc(admin, "staff", "agentA"), { status: "inactive", role: "agent", code: "AG-01" }));
  await assertFails(updateDoc(doc(admin, "staff", "agentA"), { code: "HACK", role: "agent" }));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "staff", "agentA"), { status: "active" }));
});

/* ---------------- site scoping ---------------- */
await check("an agent cannot read another site's vouchers or accounts", async () => {
  await assertFails(getDoc(doc(agentA, "vouchers", "vB-1")));
  await assertFails(getDoc(doc(agentA, "accounts", "accB")));
  await assertSucceeds(getDoc(doc(agentA, "vouchers", "vA-1")));
  await assertSucceeds(getDoc(doc(agentA, "accounts", "accA")));
});
await check("an admin reads across every site", async () => {
  await assertSucceeds(getDoc(doc(admin, "vouchers", "vB-1")));
  await assertSucceeds(getDoc(doc(admin, "accounts", "accB")));
});
await check("an agent cannot book a sale at a site they are not assigned", async () => {
  await assertFails(setDoc(doc(agentA, "sales", "x1"), {
    customer: "C", type: "V5", price: 5, pay: "cash", agentId: "agentA", siteId: SITE_B, soldAt: "2026-08-03T00:00:00Z" }));
});

/* ---------------- voucher integrity ---------------- */
// Stock is shared, so the rule is deliberately narrow: an agent may flip a
// voucher at their own site from available to sold and nothing else. Racing
// tills are separated by the transaction, not by who "owns" the code.
await check("an agent can claim any available voucher at their own site", async () => {
  await assertSucceeds(updateDoc(doc(agentA, "vouchers", "vA-1"), { status: "sold" }));
});
await check("an agent cannot claim a voucher at another site", async () => {
  await assertFails(updateDoc(doc(agentB, "vouchers", "vA-2"), { status: "sold" }));
});
await check("a sold voucher cannot be flipped back to available", async () => {
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-1"), { status: "available" }));
});
await check("a sold voucher cannot be resold", async () => {
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-1"), { status: "sold", soldAt: "2026-08-04T00:00:00Z" }));
});
await check("claiming cannot rewrite the code, group or site", async () => {
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-2"), { status: "sold", code: "W10-CHEAT" }));
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-2"), { status: "sold", type: "REC" }));
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-2"), { status: "sold", siteId: SITE_B }));
});
await check("an agent cannot mint voucher stock", async () => {
  await assertFails(setDoc(doc(agentA, "vouchers", "forged"), {
    code: "FREE", type: "V10", siteId: SITE_A, status: "available" }));
});

// This is how the till actually sells: one transaction flips the voucher and
// writes the sale, so the two can never come apart.
await check("a transaction can claim a voucher and book its sale together", async () => {
  await assertSucceeds(runTransaction(agentA, async (tx) => {
    const ref = doc(agentA, "vouchers", "vA-2");
    const snap = await tx.get(ref);
    if (snap.data().status !== "available") throw new Error("already taken");
    tx.update(ref, { status: "sold", soldAt: "2026-08-04T00:00:00Z" });
    tx.set(doc(agentA, "sales", "txSale"), {
      customer: "C", voucherId: "vA-2", voucherCode: snap.data().code,
      type: "V5", price: 5, pay: "cash", agentId: "agentA", siteId: SITE_A,
      soldAt: "2026-08-04T00:00:00Z" });
  }));
});
await check("the same transaction is refused when the sale is forged", async () => {
  await assertFails(runTransaction(agentA, async (tx) => {
    const ref = doc(agentA, "vouchers", "vA-3");
    await tx.get(ref);
    tx.update(ref, { status: "sold" });
    tx.set(doc(agentA, "sales", "txForged"), {
      customer: "C", voucherId: "vA-3", type: "V5", price: 1, pay: "cash",
      agentId: "agentA", siteId: SITE_A, soldAt: "2026-08-04T00:00:00Z" });
  }));
});

/* ---------------- ledger integrity ---------------- */
await check("sale prices are fixed by group — no discounting from the client", async () => {
  await assertFails(setDoc(doc(agentA, "sales", "cheap"), {
    customer: "C", type: "V10", price: 1, pay: "cash", agentId: "agentA", siteId: SITE_A, soldAt: "2026-08-03T00:00:00Z" }));
  await assertSucceeds(setDoc(doc(agentA, "sales", "honest"), {
    customer: "C", type: "V10", price: 10, pay: "cash", agentId: "agentA", siteId: SITE_A, soldAt: "2026-08-03T00:00:00Z" }));
});
await check("a sale cannot be attributed to another agent", async () => {
  await assertFails(setDoc(doc(agentA, "sales", "framed"), {
    customer: "C", type: "V5", price: 5, pay: "cash", agentId: "agentB", siteId: SITE_A, soldAt: "2026-08-03T00:00:00Z" }));
});
await check("a free voucher cannot be sold on credit", async () => {
  await assertFails(setDoc(doc(agentA, "sales", "freecredit"), {
    customer: "C", type: "REC", price: 0, pay: "credit", agentId: "agentA", siteId: SITE_A, soldAt: "2026-08-03T00:00:00Z" }));
});
await check("sales are immutable — nobody edits or deletes history", async () => {
  await assertFails(updateDoc(doc(agentA, "sales", "saleA"), { price: 0 }));
  await assertFails(deleteDoc(doc(agentA, "sales", "saleA")));
  await assertFails(updateDoc(doc(admin, "sales", "saleA"), { price: 0 }));
  await assertFails(deleteDoc(doc(admin, "sales", "saleA")));
});

/* ---------------- settlements ---------------- */
const pay = (extra) => Object.assign({
  accountId: "accA", siteId: SITE_A, amount: 5, method: "cash",
  receivedBy: "agentA", receivedAt: "2026-08-03T00:00:00Z", allocations: [],
}, extra);

await check("a payment must be booked to the staff member taking it", async () => {
  await assertSucceeds(setDoc(doc(agentA, "payments", "p1"), pay()));
  await assertFails(setDoc(doc(agentA, "payments", "p2"), pay({ receivedBy: "agentB" })));
});
await check("a payment cannot be recorded against another site's account", async () => {
  await assertFails(setDoc(doc(agentA, "payments", "p3"), pay({ accountId: "accB", siteId: SITE_B })));
});
// The stamped site is what the rules read, so it must not be free-form: a
// payment claiming the wrong site would be visible to the wrong staff.
await check("a payment cannot claim a site its account does not belong to", async () => {
  await assertFails(setDoc(doc(agentA, "payments", "p3b"), pay({ accountId: "accB" })));
  await assertFails(setDoc(doc(admin, "payments", "p3c"), pay({ accountId: "accA", siteId: SITE_B })));
});
await check("negative or bogus payments are rejected", async () => {
  await assertFails(setDoc(doc(agentA, "payments", "p4"), pay({ amount: -50 })));
  await assertFails(setDoc(doc(agentA, "payments", "p5"), pay({ method: "barter" })));
});
await check("settlements are immutable once recorded", async () => {
  await assertFails(updateDoc(doc(agentA, "payments", "p1"), { amount: 999 }));
  await assertFails(updateDoc(doc(admin, "payments", "p1"), { siteId: SITE_B }));
  await assertFails(deleteDoc(doc(admin, "payments", "p1")));
});
// The one permitted edit: an admin stamping the site onto a record written
// before payments carried it. Agents query settlements by site, so without
// this those payments are invisible and balances read too high.
await check("only an admin may stamp a missing site, and only the right one", async () => {
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), "payments", "pOld"), {
    accountId: "accA", amount: 5, method: "cash", receivedBy: "agentA",
    receivedAt: "2026-07-01T00:00:00Z", allocations: [] }));
  await assertFails(updateDoc(doc(agentA, "payments", "pOld"), { siteId: SITE_A }));
  await assertFails(updateDoc(doc(admin, "payments", "pOld"), { siteId: SITE_B }));
  await assertFails(updateDoc(doc(admin, "payments", "pOld"), { siteId: SITE_A, amount: 999 }));
  await assertSucceeds(updateDoc(doc(admin, "payments", "pOld"), { siteId: SITE_A }));
  // and once stamped it is immutable again
  await assertFails(updateDoc(doc(admin, "payments", "pOld"), { siteId: SITE_B }));
});

/* ---------------- the queries the app actually runs ---------------- */
// An agent cannot listen to a whole collection: the rules refuse it, and the
// app used to do exactly that — showing SYNC ERROR and then serving whatever
// the previous user had left in the local cache.
await check("an agent is refused an unscoped listen on site-scoped collections", async () => {
  for (const coll of ["vouchers", "accounts", "sales", "payments"]) {
    await assertFails(getDocs(collection(agentA, coll)));
  }
  await assertFails(getDocs(collection(agentA, "closings")));
});
await check("the same collections are readable when scoped to the agent's site", async () => {
  for (const coll of ["vouchers", "accounts", "sales", "payments"]) {
    await assertSucceeds(getDocs(query(collection(agentA, coll), where("siteId", "in", [SITE_A]))));
  }
  await assertSucceeds(getDocs(query(collection(agentA, "closings"), where("userId", "==", "agentA"))));
});
await check("scoping to somebody else's site is still refused", async () => {
  await assertFails(getDocs(query(collection(agentA, "sales"), where("siteId", "in", [SITE_B]))));
  await assertFails(getDocs(query(collection(agentA, "sales"), where("siteId", "in", [SITE_A, SITE_B]))));
  await assertFails(getDocs(query(collection(agentA, "closings"), where("userId", "==", "agentB"))));
});
await check("staff and sites stay readable unscoped — every till needs them", async () => {
  await assertSucceeds(getDocs(collection(agentA, "sites")));
  await assertSucceeds(getDocs(collection(agentA, "staff")));
});

/* ---------------- reversals ---------------- */
// Cancelling a sale must not mean editing or deleting it: the ledger keeps
// both the sale and the correction that undid it.
const reversal = (extra) => Object.assign({
  saleId: "saleA", siteId: SITE_A, voucherId: "vA-1", amount: 5,
  outcome: "restocked", reason: "double-billed", reversedBy: "admin1",
  reversedAt: "2026-08-05T00:00:00Z",
}, extra);

await check("only an admin may reverse a sale", async () => {
  await assertFails(setDoc(doc(agentA, "reversals", "rAgent"), reversal({ reversedBy: "agentA" })));
  await assertSucceeds(setDoc(doc(admin, "reversals", "r1"), reversal()));
});
await check("a reversal is booked to the admin performing it", async () => {
  await assertFails(setDoc(doc(admin, "reversals", "rFramed"), reversal({ reversedBy: "agentA" })));
});
await check("a reversal must say what became of the code", async () => {
  await assertFails(setDoc(doc(admin, "reversals", "rNoOutcome"), reversal({ outcome: "shredded" })));
  await assertSucceeds(setDoc(doc(admin, "reversals", "rVoid"), reversal({ saleId: "saleB", outcome: "voided" })));
});
await check("a reversal cannot be edited or deleted once written", async () => {
  await assertFails(updateDoc(doc(admin, "reversals", "r1"), { reason: "changed my mind" }));
  await assertFails(deleteDoc(doc(admin, "reversals", "r1")));
});
await check("reversing does not make the sale itself editable", async () => {
  await assertFails(updateDoc(doc(admin, "sales", "saleA"), { price: 0 }));
  await assertFails(deleteDoc(doc(admin, "sales", "saleA")));
});
await check("an agent reads reversals at their own site, not elsewhere", async () => {
  await assertSucceeds(getDocs(query(collection(agentA, "reversals"), where("siteId", "in", [SITE_A]))));
  await assertFails(getDocs(query(collection(agentA, "reversals"), where("siteId", "in", [SITE_B]))));
  await assertFails(getDocs(collection(agentA, "reversals")));
});
// The voucher has to be recoverable, or a reversal leaves stock permanently
// short — which is the loss the whole feature exists to undo.
await check("an admin can return a sold voucher to stock, or take it out of use", async () => {
  await assertSucceeds(updateDoc(doc(admin, "vouchers", "vA-1"), { status: "available" }));
  await assertSucceeds(updateDoc(doc(admin, "vouchers", "vA-1"), { status: "void" }));
});
await check("an agent cannot un-sell a voucher to cover a mistake", async () => {
  await env.withSecurityRulesDisabled(async (c) =>
    setDoc(doc(c.firestore(), "vouchers", "vA-sold"), {
      code: "W5-Z", type: "V5", siteId: SITE_A, status: "sold", uploadedAt: "2026-08-01T00:00:00Z" }));
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-sold"), { status: "available" }));
  await assertFails(updateDoc(doc(agentA, "vouchers", "vA-sold"), { status: "void" }));
});

/* ---------------- closings ---------------- */
await check("an agent closes only their own month, and cannot rewrite it", async () => {
  await assertSucceeds(setDoc(doc(agentA, "closings", "mine"), {
    userId: "agentA", siteId: SITE_A, period: "2026-08", totals: {} }));
  await assertFails(setDoc(doc(agentA, "closings", "theirs"), {
    userId: "agentB", siteId: SITE_A, period: "2026-08", totals: {} }));
  await assertFails(updateDoc(doc(agentA, "closings", "mine"), { totals: { totalCashCollected: 99999 } }));
});
await check("an agent cannot read another agent's closing", async () => {
  await env.withSecurityRulesDisabled(async (c) =>
    setDoc(doc(c.firestore(), "closings", "bClosing"), { userId: "agentB", siteId: SITE_B, period: "2026-08", totals: {} }));
  await assertFails(getDoc(doc(agentA, "closings", "bClosing")));
  await assertSucceeds(getDoc(doc(admin, "closings", "bClosing")));
});

/* ---------------- sites ---------------- */
await check("only admins change the site network", async () => {
  await assertFails(setDoc(doc(agentA, "sites", "rogue"), { name: "Rogue", code: "S-99", status: "active" }));
  await assertFails(updateDoc(doc(agentA, "sites", SITE_A), { name: "Renamed" }));
  await assertSucceeds(updateDoc(doc(admin, "sites", SITE_A), { name: "Camp Renamed" }));
});

/* ---------------- suspension takes effect immediately ----------------
   The token is good for up to an hour after an administrator suspends
   someone. It used to be all these rules read, so a suspended agent went
   on selling until they happened to sign out. Every one of these is done
   with a perfectly valid token. */
await check("a suspended agent cannot issue a voucher", async () => {
  await assertFails(updateDoc(doc(agentS, "vouchers", "vS-1"), { status: "sold" }));
});
await check("a suspended agent cannot book a sale", async () => {
  await assertFails(setDoc(doc(agentS, "sales", "sSusp"), {
    customer: "C", type: "V5", price: 5, pay: "cash",
    agentId: "agentS", siteId: SITE_A, soldAt: "2026-08-09T00:00:00Z" }));
});
await check("a suspended agent cannot take a customer's money", async () => {
  await assertFails(setDoc(doc(agentS, "payments", "pSusp"), {
    accountId: "accA", siteId: SITE_A, amount: 10, method: "cash",
    receivedBy: "agentS", receivedAt: "2026-08-09T00:00:00Z", allocations: [] }));
});
await check("a suspended agent cannot open an account or close a month", async () => {
  await assertFails(setDoc(doc(agentS, "accounts", "accSusp"), { name: "New", phone: "", siteId: SITE_A }));
  await assertFails(setDoc(doc(agentS, "closings", "clSusp"), {
    userId: "agentS", siteId: SITE_A, period: "2026-08", totals: {} }));
});
await check("a suspended administrator cannot manage stock, staff or reversals", async () => {
  await assertFails(setDoc(doc(adminS, "vouchers", "vNew"), {
    code: "W5-N", type: "V5", siteId: SITE_A, status: "available", uploadedAt: "2026-08-09T00:00:00Z" }));
  await assertFails(updateDoc(doc(adminS, "staff", "agentA"), { status: "inactive", role: "agent" }));
  await assertFails(setDoc(doc(adminS, "reversals", "revSusp"), {
    saleId: "saleA", siteId: SITE_A, outcome: "restocked",
    reversedBy: "adminS", reversedAt: "2026-08-09T00:00:00Z" }));
  await assertFails(deleteDoc(doc(adminS, "vouchers", "vA-3")));
});
await check("someone deleted from the team cannot write at all", async () => {
  await assertFails(setDoc(doc(ghost, "sales", "sGhost"), {
    customer: "C", type: "V5", price: 5, pay: "cash",
    agentId: "ghost", siteId: SITE_A, soldAt: "2026-08-09T00:00:00Z" }));
  await assertFails(updateDoc(doc(ghost, "vouchers", "vS-1"), { status: "sold" }));
});
await check("a suspended till can still read — that is how it learns it is suspended", async () => {
  await assertSucceeds(getDoc(doc(agentS, "staff", "agentS")));
  await assertSucceeds(getDocs(collection(agentS, "staff")));
});
await check("reactivating restores selling, with no new sign-in", async () => {
  await env.withSecurityRulesDisabled(async (c) =>
    updateDoc(doc(c.firestore(), "staff", "agentS"), { status: "active" }));
  await assertSucceeds(updateDoc(doc(agentS, "vouchers", "vS-1"), { status: "sold" }));
  await env.withSecurityRulesDisabled(async (c) =>
    updateDoc(doc(c.firestore(), "staff", "agentS"), { status: "inactive" }));
});

/* ---------------- unknown collections ---------------- */
await check("undeclared collections are denied by default", async () => {
  await assertFails(setDoc(doc(admin, "anythingElse", "x"), { a: 1 }));
  await assertFails(getDoc(doc(agentA, "anythingElse", "x")));
});

await env.cleanup();

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} rules checks passed`);
process.exit(failed ? 1 : 0);

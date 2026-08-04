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

// seed with rules disabled
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, "sites", SITE_A), { name: "Camp", code: "S-01", status: "active" });
  await setDoc(doc(d, "sites", SITE_B), { name: "Kiosk", code: "S-02", status: "active" });
  await setDoc(doc(d, "staff", "agentA"), { name: "A", code: "AG-01", role: "agent", siteIds: [SITE_A], status: "active" });
  await setDoc(doc(d, "staff", "admin1"), { name: "Boss", code: "ADM-01", role: "admin", siteIds: [], status: "active" });
  await setDoc(doc(d, "staffAuth", "agentA"), { hash: "secret", salt: "s" });
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
await check("a payment must be booked to the staff member taking it", async () => {
  await assertSucceeds(setDoc(doc(agentA, "payments", "p1"), {
    accountId: "accA", amount: 5, method: "cash", receivedBy: "agentA", receivedAt: "2026-08-03T00:00:00Z", allocations: [] }));
  await assertFails(setDoc(doc(agentA, "payments", "p2"), {
    accountId: "accA", amount: 5, method: "cash", receivedBy: "agentB", receivedAt: "2026-08-03T00:00:00Z", allocations: [] }));
});
await check("a payment cannot be recorded against another site's account", async () => {
  await assertFails(setDoc(doc(agentA, "payments", "p3"), {
    accountId: "accB", amount: 5, method: "cash", receivedBy: "agentA", receivedAt: "2026-08-03T00:00:00Z", allocations: [] }));
});
await check("negative or bogus payments are rejected", async () => {
  await assertFails(setDoc(doc(agentA, "payments", "p4"), {
    accountId: "accA", amount: -50, method: "cash", receivedBy: "agentA", receivedAt: "2026-08-03T00:00:00Z", allocations: [] }));
  await assertFails(setDoc(doc(agentA, "payments", "p5"), {
    accountId: "accA", amount: 5, method: "barter", receivedBy: "agentA", receivedAt: "2026-08-03T00:00:00Z", allocations: [] }));
});
await check("settlements are immutable once recorded", async () => {
  await assertFails(updateDoc(doc(agentA, "payments", "p1"), { amount: 999 }));
  await assertFails(deleteDoc(doc(admin, "payments", "p1")));
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

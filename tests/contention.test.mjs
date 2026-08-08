/* ============================================================
   Can two tills issue the same voucher?

   Every till claims stock straight from the shared pool inside a
   Firestore transaction — there is no central dispenser handing codes
   out one at a time. This proves that is enough: N tills reach for the
   same small pool at the same instant, each its own Firebase app and
   its own signed-in agent, and no code may come out twice.

   The oversubscribed run is the interesting one. With more tills than
   vouchers, every till that loses has to be told the stock ran out
   rather than handed a code somebody else already has.

     TILLS=12 POOL=12 node tests/contention.mjs    # exact fit
     TILLS=20 POOL=8  node tests/contention.mjs    # oversubscribed
   ============================================================ */
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken, connectAuthEmulator } from "firebase/auth";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";
import {
  getFirestore, connectFirestoreEmulator, doc, setDoc, collection, getDocs,
  writeBatch, query, where, runTransaction, initializeFirestore,
} from "firebase/firestore";

const PROJECT = "nexus-pos-fn-test";
const REST = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const TILLS = Number(process.env.TILLS || 12);
const POOL = Number(process.env.POOL || 12);

await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

// one admin, one site, a small pool — so every till fights for the same codes
const boot = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT, authDomain: `${PROJECT}.firebaseapp.com` }, "boot");
const bAuth = getAuth(boot); connectAuthEmulator(bAuth, "http://127.0.0.1:9099", { disableWarnings: true });
const bFns = getFunctions(boot); connectFunctionsEmulator(bFns, "127.0.0.1", 5001);
const bDb = getFirestore(boot); connectFirestoreEmulator(bDb, "127.0.0.1", 8080);
const call = (n, d) => httpsCallable(bFns, n)(d || {}).then((r) => r.data);

const bs = await call("bootstrap", { name: "Ada", code: "ADM-01", pin: "1234", siteName: "Camp" });
const siteId = bs.siteId;
const admin = await call("signIn", { code: "ADM-01", pin: "1234" });
await signInWithCustomToken(bAuth, admin.token);
{
  const batch = writeBatch(bDb);
  for (let i = 0; i < POOL; i++) {
    batch.set(doc(bDb, "vouchers", `v${i}`), {
      code: `W5-${String(i).padStart(3, "0")}`, type: "V5", siteId, status: "available",
      uploadedAt: "2026-08-01T00:00:00Z", batch: "B-1",
    });
  }
  await batch.commit();
}
// one agent account per till, all at the same site
const agents = [];
for (let i = 0; i < TILLS; i++) {
  const code = `AG-${String(i).padStart(2, "0")}`;
  await call("createStaff", { name: `Agent ${i}`, code, role: "agent", pin: "1111", siteIds: [siteId] });
  agents.push(code);
}
console.log(`${TILLS} tills, ${POOL} vouchers at one site\n`);

// each till is its own Firebase app, as it would be its own device
const tills = await Promise.all(agents.map(async (code, i) => {
  const app = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT, authDomain: `${PROJECT}.firebaseapp.com` }, `till${i}`);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const fns = getFunctions(app); connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  const db = initializeFirestore(app, {}); connectFirestoreEmulator(db, "127.0.0.1", 8080);
  const res = await httpsCallable(fns, "signIn")({ code, pin: "1111" }).then((r) => r.data);
  await signInWithCustomToken(auth, res.token);
  return { db, uid: res.staff.id, code };
}));

// the same claim the till performs, minus the UI
const claim = async (t) => {
  const pool = await getDocs(query(collection(t.db, "vouchers"),
    where("siteId", "==", siteId), where("type", "==", "V5"), where("status", "==", "available")));
  const ids = pool.docs.map((d) => d.id).sort();
  let denied = 0;
  for (const id of ids) {
    try {
      return await runTransaction(t.db, async (tx) => {
        const ref = doc(t.db, "vouchers", id);
        const snap = await tx.get(ref);
        if (!snap.exists() || snap.data().status !== "available") throw new Error("TAKEN");
        tx.update(ref, { status: "sold", soldAt: new Date().toISOString() });
        tx.set(doc(t.db, "sales", `${t.uid}-${id}`), {
          customer: "Load Test", voucherId: id, voucherCode: snap.data().code,
          type: "V5", price: 5, pay: "cash", agentId: t.uid, agentName: t.code,
          siteId, soldAt: new Date().toISOString(),
        });
        return snap.data().code;
      });
    } catch (e) {
      const d = String(e.code || "") + " " + String(e.message || e);
      if (/TAKEN|aborted|contention/i.test(d)) continue;
      if (/permission[-_ ]denied/i.test(d)) { denied++; continue; }
      throw e;
    }
  }
  return ids.length && denied === ids.length ? "DENIED" : "OUT_OF_STOCK";
};

const t0 = Date.now();
const results = await Promise.all(tills.map((t) => claim(t).catch((e) => "ERR:" + e.message)));
const ms = Date.now() - t0;

const issued = results.filter((r) => /^W5-/.test(r));
const dupes = issued.filter((c, i) => issued.indexOf(c) !== i);
const out = results.filter((r) => r === "OUT_OF_STOCK").length;
const errs = results.filter((r) => String(r).startsWith("ERR:"));

console.log(`issued            ${issued.length}`);
console.log(`distinct codes    ${new Set(issued).size}`);
console.log(`duplicates        ${dupes.length}${dupes.length ? "  ← " + dupes.join(",") : ""}`);
console.log(`out of stock      ${out}`);
console.log(`errors            ${errs.length}${errs.length ? "  " + errs[0] : ""}`);
console.log(`all ${TILLS} tills settled in ${ms}ms`);
const dist = {};
for (const r of results) { const k = /^W5-/.test(r) ? 'issued a code' : r; dist[k] = (dist[k] || 0) + 1; }
console.log('outcomes:', JSON.stringify(dist));

// the server is the authority, so check it rather than the clients
const server = await (await fetch(`${REST}/vouchers`, { headers: OWNER })).json();
const sold = (server.documents || []).filter((d) => d.fields.status.stringValue === "sold");
const soldCodes = sold.map((d) => d.fields.code.stringValue);
console.log(`\nserver: ${sold.length} sold, ${new Set(soldCodes).size} distinct`);
const salesDoc = await (await fetch(`${REST}/sales`, { headers: OWNER })).json();
console.log(`server: ${(salesDoc.documents || []).length} sales recorded`);

const ok = dupes.length === 0 && new Set(soldCodes).size === sold.length && sold.length === issued.length;
console.log(ok ? "\nPASS  no voucher was issued twice" : "\nFAIL  a voucher was issued more than once");
process.exit(ok ? 0 : 1);

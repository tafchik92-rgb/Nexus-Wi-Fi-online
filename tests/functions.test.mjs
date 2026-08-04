/* ============================================================
   Cloud Function tests — run against the emulator suite.
   Covers the things the browser must never be trusted with:
   PIN verification, lockout, role checks, bootstrap replay, and
   the transactional voucher claim that stops two tills issuing the
   same code.

   Usage:  node tests/run-functions-tests.mjs
   ============================================================ */
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken, signOut, connectAuthEmulator } from "firebase/auth";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";
import {
  getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, collection, getDocs,
  writeBatch, query, where, runTransaction,
} from "firebase/firestore";

const PROJECT = "nexus-pos-fn-test";
const app = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT, authDomain: `${PROJECT}.firebaseapp.com` });
const auth = getAuth(app);
const fns = getFunctions(app);
const db = getFirestore(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
connectFirestoreEmulator(db, "127.0.0.1", 8080);

const call = (name, data) => httpsCallable(fns, name)(data || {}).then((r) => r.data);
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", `${name} → ${String(e.message || e).split("\n")[0]}`]); }
};
const mustThrow = async (fn, expect) => {
  try { await fn(); } catch (e) {
    const msg = String(e.message || e);
    if (expect && !msg.toLowerCase().includes(expect.toLowerCase())) {
      throw new Error(`wrong error: ${msg}`);
    }
    return;
  }
  throw new Error("expected a rejection, got success");
};

// The rules deny all client access to staffAuth (by design), so privileged
// setup and inspection go through the emulator's owner REST endpoint.
const REST = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const restGet = async (path) => {
  const r = await fetch(`${REST}/${path}`, { headers: OWNER });
  if (!r.ok) throw new Error(`REST ${r.status} on ${path}`);
  return r.json();
};
const clearLock = (staffId) => fetch(
  `${REST}/staffAuth/${staffId}?updateMask.fieldPaths=failedAttempts&updateMask.fieldPaths=lockedUntil`,
  { method: "PATCH", headers: OWNER,
    body: JSON.stringify({ fields: { failedAttempts: { integerValue: "0" }, lockedUntil: { nullValue: null } } }) });
const wipe = () => fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });

await wipe();

let adminStaffId, siteId, agentStaffId;

/* ---------------- bootstrap ---------------- */
await check("bootstrap creates the founding admin and first site", async () => {
  const res = await call("bootstrap", { name: "Ada", code: "ADM-01", pin: "1234", siteName: "Camp" });
  if (!res.ok || !res.staffId) throw new Error("no staffId returned");
  adminStaffId = res.staffId;
  siteId = res.siteId;
});
await check("bootstrap cannot be replayed once staff exist", async () => {
  await mustThrow(() => call("bootstrap", { name: "Imposter", code: "ADM-99", pin: "9999" }), "already set up");
});
await check("bootstrap refuses a weak PIN", async () => {
  await wipe();
  await mustThrow(() => call("bootstrap", { name: "Ada", code: "ADM-01", pin: "12" }), "4–8 digits");
  const res = await call("bootstrap", { name: "Ada", code: "ADM-01", pin: "1234", siteName: "Camp" });
  adminStaffId = res.staffId; siteId = res.siteId;
});

/* ---------------- PIN handling ---------------- */
await check("the client cannot read PIN material at all", async () => {
  await mustThrow(() => getDoc(doc(db, "staffAuth", adminStaffId)));
});
await check("the PIN is never stored in the clear", async () => {
  const raw = await restGet(`staffAuth/${adminStaffId}`);
  const body = JSON.stringify(raw);
  if (body.includes("1234")) throw new Error("PIN found in the stored record!");
  const f = raw.fields || {};
  if (!f.salt || !f.hash || (f.algo && f.algo.stringValue !== "scrypt")) {
    throw new Error("expected a salted scrypt hash, got " + Object.keys(f).join(","));
  }
  if (f.hash.stringValue.length < 64) throw new Error("hash looks too short");
});
await check("signIn rejects a wrong PIN without confirming the code exists", async () => {
  await mustThrow(() => call("signIn", { code: "ADM-01", pin: "0000" }), "Incorrect staff code or PIN");
  await mustThrow(() => call("signIn", { code: "NOPE-99", pin: "0000" }), "Incorrect staff code or PIN");
});
await check("signIn returns a working token for the right PIN", async () => {
  const res = await call("signIn", { code: "ADM-01", pin: "1234" });
  if (!res.token) throw new Error("no token");
  const cred = await signInWithCustomToken(auth, res.token);
  const tok = await cred.user.getIdTokenResult();
  if (tok.claims.role !== "admin") throw new Error("role claim missing: " + JSON.stringify(tok.claims));
  if (cred.user.uid !== adminStaffId) throw new Error("uid mismatch");
});

/* ---------------- lockout ---------------- */
await check("repeated wrong PINs lock the account", async () => {
  for (let i = 0; i < 5; i++) {
    await call("signIn", { code: "ADM-01", pin: "0000" }).catch(() => {});
  }
  await mustThrow(() => call("signIn", { code: "ADM-01", pin: "1234" }), "Too many failed attempts");
  // clear the lock so the rest of the suite can run (owner endpoint, not the client)
  await clearLock(adminStaffId);
  const ok = await call("signIn", { code: "ADM-01", pin: "1234" });
  if (!ok.token) throw new Error("still locked after clearing");
  await signInWithCustomToken(auth, ok.token);
});

/* ---------------- staff provisioning ---------------- */
await check("an admin can create an agent", async () => {
  const res = await call("createStaff", {
    name: "Kira", code: "AG-01", role: "agent", pin: "1111", siteIds: [siteId] });
  agentStaffId = res.staffId;
  const staff = await getDoc(doc(db, "staff", agentStaffId));
  if (staff.data().role !== "agent") throw new Error("role wrong");
  if (JSON.stringify(staff.data()).includes("1111")) throw new Error("PIN leaked into the staff doc!");
});
await check("duplicate staff codes are refused", async () => {
  await mustThrow(() => call("createStaff", {
    name: "Clone", code: "AG-01", role: "agent", pin: "2222", siteIds: [siteId] }), "already assigned");
});
await check("an agent cannot create staff or reset PINs", async () => {
  const res = await call("signIn", { code: "AG-01", pin: "1111" });
  await signInWithCustomToken(auth, res.token);
  await mustThrow(() => call("createStaff", {
    name: "Sneaky", code: "AG-02", role: "admin", pin: "3333", siteIds: [siteId] }), "Administrators only");
  await mustThrow(() => call("resetPin", { staffId: adminStaffId }), "Administrators only");
});
await check("a signed-out client cannot call privileged functions", async () => {
  await signOut(auth);
  await mustThrow(() => call("createStaff", { name: "X", code: "Z", role: "admin", pin: "4444" }), "Sign in");
  await mustThrow(() => call("changePin", { currentPin: "1234", newPin: "4321" }), "Sign in");
  await mustThrow(() => call("resetPin", { staffId: adminStaffId }), "Sign in");
});

/* ---------------- PIN change / reset ---------------- */
await check("changePin requires the current PIN", async () => {
  const res = await call("signIn", { code: "AG-01", pin: "1111" });
  await signInWithCustomToken(auth, res.token);
  await mustThrow(() => call("changePin", { currentPin: "9999", newPin: "5555" }), "Current PIN is incorrect");
  await call("changePin", { currentPin: "1111", newPin: "5555" });
  await mustThrow(() => call("signIn", { code: "AG-01", pin: "1111" }), "Incorrect");
  const ok = await call("signIn", { code: "AG-01", pin: "5555" });
  if (!ok.token) throw new Error("new PIN does not work");
});
await check("an admin reset issues a fresh PIN that works", async () => {
  const a = await call("signIn", { code: "ADM-01", pin: "1234" });
  await signInWithCustomToken(auth, a.token);
  const { pin } = await call("resetPin", { staffId: agentStaffId });
  if (!/^\d{4}$/.test(pin)) throw new Error("bad pin: " + pin);
  const res = await call("signIn", { code: "AG-01", pin });
  if (!res.token) throw new Error("reset PIN does not work");
});

/* ---------------- selling: the transactional claim ---------------- */
// This is the real selling path. There is no reservation step any more: a
// till claims stock straight out of the shared pool inside a transaction,
// and the server decides who won.
// Mirrors Backend.claimAndSell, including how a lost race actually surfaces:
// not as ABORTED but as a rules rejection, because by commit time the voucher
// is already sold and "status == available" no longer holds.
const claim = async (db_, site, type) => {
  const pool = await getDocs(query(collection(db_, "vouchers"),
    where("siteId", "==", site), where("type", "==", type), where("status", "==", "available")));
  const ids = pool.docs.map((d) => d.id).sort();
  let denied = 0;
  for (const id of ids) {
    try {
      return await runTransaction(db_, async (tx) => {
        const ref = doc(db_, "vouchers", id);
        const snap = await tx.get(ref);
        if (!snap.exists() || snap.data().status !== "available") throw new Error("TAKEN");
        tx.update(ref, { status: "sold", soldAt: new Date().toISOString() });
        return { id, code: snap.data().code };
      });
    } catch (e) {
      const detail = String(e.code || "") + " " + String(e.message || e);
      if (/TAKEN|aborted|contention/i.test(detail)) continue;
      if (/permission[-_ ]denied|insufficient permissions/i.test(detail)) { denied++; continue; }
      throw e;
    }
  }
  throw new Error(ids.length && denied === ids.length ? "DENIED" : "OUT_OF_STOCK");
};

let agentDb, agentUid;
await check("stock loaded by an admin is visible to the agent at that site", async () => {
  const a = await call("signIn", { code: "ADM-01", pin: "1234" });
  await signInWithCustomToken(auth, a.token);
  const batch = writeBatch(db);
  for (let i = 0; i < 12; i++) {
    batch.set(doc(db, "vouchers", `v${i}`), {
      code: `W5-${i}`, type: "V5", siteId, status: "available",
      uploadedAt: "2026-08-01T00:00:00Z", batch: "B-T" });
  }
  await batch.commit();

  const agentPin = (await call("resetPin", { staffId: agentStaffId })).pin;
  const agent = await call("signIn", { code: "AG-01", pin: agentPin });
  await signInWithCustomToken(auth, agent.token);
  agentDb = db;
  agentUid = auth.currentUser.uid;
  const seen = await getDocs(query(collection(db, "vouchers"), where("siteId", "==", siteId)));
  if (seen.size !== 12) throw new Error("agent sees " + seen.size + " of 12");
});

await check("a claim flips exactly one voucher to sold", async () => {
  const won = await claim(agentDb, siteId, "V5");
  const after = await getDoc(doc(db, "vouchers", won.id));
  if (after.data().status !== "sold") throw new Error("voucher not sold");
  const left = await getDocs(query(collection(db, "vouchers"),
    where("siteId", "==", siteId), where("status", "==", "available")));
  if (left.size !== 11) throw new Error("stock is " + left.size + ", expected 11");
});

await check("eleven concurrent claims hand out eleven distinct codes", async () => {
  const won = await Promise.all(Array.from({ length: 11 }, () => claim(agentDb, siteId, "V5")));
  const ids = new Set(won.map((w) => w.id));
  if (ids.size !== 11) throw new Error(`${11 - ids.size} code(s) issued twice`);
  const codes = new Set(won.map((w) => w.code));
  if (codes.size !== 11) throw new Error("duplicate codes: " + [...codes].join(","));
});

await check("the pool is empty once every code is claimed", async () => {
  await mustThrow(() => claim(agentDb, siteId, "V5"), "OUT_OF_STOCK");
});

await check("a sold voucher cannot be claimed a second time", async () => {
  await mustThrow(() => runTransaction(db, async (tx) => {
    const ref = doc(db, "vouchers", "v0");
    await tx.get(ref);
    tx.update(ref, { status: "sold" });
  }));
});

await check("an agent cannot claim stock at a site they are not assigned", async () => {
  // agents cannot create sites (rules deny it), so seed via the owner endpoint
  await fetch(`${REST}/sites?documentId=otherSite`, { method: "POST", headers: OWNER,
    body: JSON.stringify({ fields: { name: { stringValue: "Elsewhere" }, code: { stringValue: "S-02" }, status: { stringValue: "active" } } }) });
  await fetch(`${REST}/vouchers?documentId=vOther`, { method: "POST", headers: OWNER,
    body: JSON.stringify({ fields: {
      code: { stringValue: "W5-X" }, type: { stringValue: "V5" },
      siteId: { stringValue: "otherSite" }, status: { stringValue: "available" },
      uploadedAt: { stringValue: "2026-08-01T00:00:00Z" } } }) });
  await mustThrow(() => runTransaction(db, async (tx) => {
    const ref = doc(db, "vouchers", "vOther");
    await tx.get(ref);
    tx.update(ref, { status: "sold" });
  }));
});

await check("an agent cannot enumerate vouchers outside a site-scoped query", async () => {
  await mustThrow(() => getDocs(collection(db, "vouchers")));
});

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} function checks passed`);
process.exit(failed ? 1 : 0);

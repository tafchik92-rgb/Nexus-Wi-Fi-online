/* ============================================================
   NEXUS//POS — Cloud Functions
   Everything the client must not be trusted with: PIN verification,
   staff provisioning and role claims.

   Selling is not here on purpose. A till claims a voucher with a Firestore
   transaction the security rules police, which is one round trip instead of
   two and puts the guarantee in the database rather than in code a client
   could route around.
   ============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("crypto");

initializeApp();

// The project's Firestore may be a NAMED database rather than "(default)".
// The Admin SDK defaults to "(default)", so without this the functions read
// and write a database nobody else is using.
//
// FIRESTORE_DATABASE_ID overrides it whenever it is set at all — including to
// an empty string, which means "(default)".
//
// Under the emulator the default flips to "(default)": an emulated project has
// only that one database, so carrying the production id across would put these
// functions in a database the tests and the client never look at, and every
// check would fail as a missing document rather than a real fault.
const PROD_DATABASE_ID = "ai-studio-nexuswifi-c56b2e13-8e06-41aa-bd40-1bd12d4dfe0f";
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID !== undefined
  ? process.env.FIRESTORE_DATABASE_ID
  : (process.env.FUNCTIONS_EMULATOR === "true" ? "" : PROD_DATABASE_ID);
const dbf = () => (DATABASE_ID ? getFirestore(DATABASE_ID) : getFirestore());

/* ------------------------------------------------------------
   PIN hashing — scrypt (Node built-in KDF, no dependency)
   ------------------------------------------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString("hex");
}

function makePinRecord(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPin(pin, salt), algo: "scrypt", updatedAt: FieldValue.serverTimestamp() };
}

// Constant-time compare so a wrong PIN never leaks position via timing.
function pinMatches(pin, record) {
  if (!record || !record.hash || !record.salt) return false;
  const candidate = Buffer.from(hashPin(pin, record.salt), "hex");
  const stored = Buffer.from(record.hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

const validPin = (pin) => typeof pin === "string" && /^\d{4,8}$/.test(pin);

/* ------------------------------------------------------------
   Error translation.

   An unhandled throw surfaces in the browser as a bare "internal",
   which tells an operator nothing. Wrap every handler so real faults
   arrive as the specific thing to go and fix — the two that bite on a
   first deploy are Firestore not being created yet, and the runtime
   service account lacking permission to sign custom tokens.
   ------------------------------------------------------------ */
function translate(err) {
  if (err instanceof HttpsError) return err;
  const msg = String((err && err.message) || err || "");
  const code = (err && err.code) || "";

  if (/iam\.serviceAccounts\.signBlob|signBlob|Permission.*denied.*sign/i.test(msg)) {
    return new HttpsError("failed-precondition",
      "This project cannot sign sign-in tokens yet. Grant the functions service account the " +
      "'Service Account Token Creator' role and enable the IAM Service Account Credentials API, " +
      "then try again. Re-running deploy.sh does both.");
  }
  if (/NOT_FOUND|database.*does not exist|5 NOT_FOUND/i.test(msg) || code === 5) {
    return new HttpsError("failed-precondition",
      "No Firestore database in this project. Create one in the Firebase console " +
      "(Build → Firestore Database → Create database) and try again.");
  }
  if (/PERMISSION_DENIED|7 PERMISSION_DENIED/i.test(msg) || code === 7) {
    return new HttpsError("failed-precondition",
      "The functions service account is missing permission to read or write Firestore. " +
      "Grant it the 'Cloud Datastore User' role and try again.");
  }
  if (/CONFIGURATION_NOT_FOUND|identitytoolkit|auth\/configuration/i.test(msg)) {
    return new HttpsError("failed-precondition",
      "Authentication is not enabled on this project. In the Firebase console open " +
      "Authentication → Get started and enable the Anonymous provider, then try again.");
  }
  console.error("Unhandled function error:", err);
  return new HttpsError("internal", `Unexpected server error: ${msg.slice(0, 300)}`);
}

// Wraps a callable so failures arrive as something actionable.
const guard = (handler) => async (req) => {
  try {
    return await handler(req);
  } catch (err) {
    throw translate(err);
  }
};
const clean = (s, max = 60) => String(s == null ? "" : s).trim().slice(0, max);

/* ------------------------------------------------------------
   Lockout — blunt but effective against PIN guessing
   ------------------------------------------------------------ */
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------
   bootstrap — creates the founding administrator.
   Only works while no staff exist, so it cannot be replayed.
   ------------------------------------------------------------ */
exports.bootstrap = onCall(guard(async (req) => {
  const db = dbf();
  const name = clean(req.data && req.data.name);
  const code = clean(req.data && req.data.code, 12).toUpperCase();
  const pin = req.data && req.data.pin;
  const siteName = clean(req.data && req.data.siteName, 50) || "Main Shop";

  if (!name || !code) throw new HttpsError("invalid-argument", "Name and staff code are required.");
  if (!validPin(pin)) throw new HttpsError("invalid-argument", "PIN must be 4–8 digits.");

  const existing = await db.collection("staff").limit(1).get();
  if (!existing.empty) {
    throw new HttpsError("failed-precondition", "This shop is already set up. Ask an administrator for an account.");
  }

  const staffRef = db.collection("staff").doc();
  const siteRef = db.collection("sites").doc();
  const batch = db.batch();
  batch.set(siteRef, {
    name: siteName, code: "S-01", status: "active", createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(staffRef, {
    name, code, role: "admin", siteIds: [], status: "active", createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection("staffAuth").doc(staffRef.id), makePinRecord(pin));
  await batch.commit();

  return { ok: true, staffId: staffRef.id, siteId: siteRef.id };
}));

/* ------------------------------------------------------------
   signIn — the only place a PIN is ever checked
   ------------------------------------------------------------ */
exports.signIn = onCall(guard(async (req) => {
  const db = dbf();
  const code = clean(req.data && req.data.code, 12).toUpperCase();
  const pin = req.data && req.data.pin;
  if (!code || !pin) throw new HttpsError("invalid-argument", "Staff code and PIN are required.");

  const snap = await db.collection("staff").where("code", "==", code).limit(1).get();
  // Same message whether the code or the PIN was wrong — don't confirm codes.
  const reject = () => new HttpsError("permission-denied", "Incorrect staff code or PIN.");
  if (snap.empty) throw reject();

  const staffDoc = snap.docs[0];
  const staff = staffDoc.data();
  if (staff.status !== "active") {
    throw new HttpsError("permission-denied", "That account is suspended. Ask an administrator.");
  }

  const authRef = db.collection("staffAuth").doc(staffDoc.id);
  const authSnap = await authRef.get();
  const record = authSnap.exists ? authSnap.data() : null;
  if (!record || !record.hash) {
    throw new HttpsError("failed-precondition", "No PIN set for this account. An administrator must reset it.");
  }

  const now = Date.now();
  const lockedUntil = record.lockedUntil ? record.lockedUntil.toMillis() : 0;
  if (lockedUntil > now) {
    const mins = Math.ceil((lockedUntil - now) / 60000);
    throw new HttpsError("resource-exhausted", `Too many failed attempts. Try again in ${mins} minute(s).`);
  }

  if (!pinMatches(pin, record)) {
    const failed = (record.failedAttempts || 0) + 1;
    const update = { failedAttempts: failed, lastFailedAt: FieldValue.serverTimestamp() };
    if (failed >= MAX_ATTEMPTS) {
      update.lockedUntil = new Date(now + LOCK_MS);
      update.failedAttempts = 0;
    }
    await authRef.set(update, { merge: true });
    throw reject();
  }

  await authRef.set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: FieldValue.serverTimestamp() }, { merge: true });

  // Role and site scope travel in the token; the rules read them from there,
  // so a client cannot widen its own access.
  const token = await getAuth().createCustomToken(staffDoc.id, {
    role: staff.role === "admin" ? "admin" : "agent",
    siteIds: Array.isArray(staff.siteIds) ? staff.siteIds.slice(0, 40) : [],
    code: staff.code,
  });

  return { token, staff: { id: staffDoc.id, name: staff.name, code: staff.code, role: staff.role, siteIds: staff.siteIds || [] } };
}));

/* ------------------------------------------------------------
   Staff provisioning (admin only)
   ------------------------------------------------------------ */
async function requireAdmin(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = dbf();
  // Re-read the record rather than trusting the token's role claim, so a
  // demoted admin loses access without waiting for their token to expire.
  const doc = await db.collection("staff").doc(req.auth.uid).get();
  if (!doc.exists || doc.data().role !== "admin" || doc.data().status !== "active") {
    throw new HttpsError("permission-denied", "Administrators only.");
  }
  return doc;
}

exports.createStaff = onCall(guard(async (req) => {
  await requireAdmin(req);
  const db = dbf();
  const name = clean(req.data && req.data.name);
  const code = clean(req.data && req.data.code, 12).toUpperCase();
  const role = (req.data && req.data.role) === "admin" ? "admin" : "agent";
  const pin = req.data && req.data.pin;
  const siteIds = Array.isArray(req.data && req.data.siteIds) ? req.data.siteIds.slice(0, 40) : [];

  if (!name || !code) throw new HttpsError("invalid-argument", "Name and staff code are required.");
  if (!validPin(pin)) throw new HttpsError("invalid-argument", "PIN must be 4–8 digits.");
  if (role === "agent" && siteIds.length === 0) {
    throw new HttpsError("invalid-argument", "Assign the agent to at least one site.");
  }

  const clash = await db.collection("staff").where("code", "==", code).limit(1).get();
  if (!clash.empty) throw new HttpsError("already-exists", `Code ${code} is already assigned.`);

  const ref = db.collection("staff").doc();
  await db.batch()
    .set(ref, { name, code, role, siteIds, status: "active", createdAt: FieldValue.serverTimestamp() })
    .set(db.collection("staffAuth").doc(ref.id), makePinRecord(pin))
    .commit();

  return { ok: true, staffId: ref.id };
}));

// Change your own PIN — current PIN required.
exports.changePin = onCall(guard(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = dbf();
  const { currentPin, newPin } = req.data || {};
  if (!validPin(newPin)) throw new HttpsError("invalid-argument", "New PIN must be 4–8 digits.");

  const ref = db.collection("staffAuth").doc(req.auth.uid);
  const snap = await ref.get();
  if (snap.exists && snap.data().hash && !pinMatches(currentPin, snap.data())) {
    throw new HttpsError("permission-denied", "Current PIN is incorrect.");
  }
  await ref.set(makePinRecord(newPin), { merge: true });
  return { ok: true };
}));

// Admin resets someone else's PIN; the generated PIN is returned once.
exports.resetPin = onCall(guard(async (req) => {
  await requireAdmin(req);
  const db = dbf();
  const staffId = clean(req.data && req.data.staffId, 60);
  if (!staffId) throw new HttpsError("invalid-argument", "staffId is required.");
  const staff = await db.collection("staff").doc(staffId).get();
  if (!staff.exists) throw new HttpsError("not-found", "No such staff member.");

  const pin = String(crypto.randomInt(1000, 10000));
  await db.collection("staffAuth").doc(staffId).set(
    Object.assign(makePinRecord(pin), { failedAttempts: 0, lockedUntil: null }), { merge: true });
  return { ok: true, pin };
}));

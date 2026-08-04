/* ============================================================
   NEXUS//POS — cloud backend adapter (Firebase)

   Local mode stays exactly as it was: zero dependencies, localStorage.
   Cloud mode loads the Firebase SDK on demand, signs in through the
   signIn Cloud Function (the PIN is never checked in the browser), and
   mirrors Firestore into the same in-memory `db` the UI already reads —
   so every view, report and export works unchanged.

   Offline: Firestore's persistent cache keeps reads and queued writes
   working with no connection. Vouchers are sold from a block this device
   reserved while online, so two tills can never issue the same code.
   ============================================================ */
"use strict";

const CLOUD_KEY = "nexuspos.cloud";
const SDK_VERSION = "10.14.1";
const SDK = (m) => `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-${m}.js`;

const COLLECTIONS = {
  sites: "sites",
  users: "staff",
  vouchers: "vouchers",
  accounts: "accounts",
  sales: "sales",
  payments: "payments",
  closings: "closings",
};

/* ------------------------------------------------------------
   The Firebase console hands you JavaScript, not JSON:

     const firebaseConfig = { apiKey: "…", appId: "…" };

   Unquoted keys, a declaration prefix, a trailing semicolon — none of
   which JSON.parse accepts. Take it as pasted and normalise it, rather
   than making the operator hand-convert and risk a typo.
   ------------------------------------------------------------ */
// Removes // and /* */ comments without touching quoted text — a naive
// regex would eat the "//" in "https://…" and truncate the value.
function stripComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next === undefined ? "" : next; i++; }
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out;
}

function parseFirebaseConfig(text) {
  let raw = String(text || "").trim();
  if (!raw) throw new Error("Paste the firebaseConfig object from the Firebase console.");

  // keep only the outermost { … } block
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open === -1 || close <= open) {
    throw new Error("That does not look like a config object — it should contain { … }.");
  }
  raw = raw.slice(open, close + 1);
  raw = stripComments(raw);

  const attempts = [
    raw,
    // quote bare keys, convert single to double quotes, drop trailing commas
    raw.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
       .replace(/:\s*'([^']*)'/g, ': "$1"')
       .replace(/,(\s*[}\]])/g, "$1"),
  ];
  // an unquoted appId (1:234:web:abc) is the usual paste error — quote it
  attempts.push(attempts[1].replace(/:\s*([0-9][\w:.-]*[A-Za-z][\w:.-]*)\s*([,}])/g, ': "$1"$2'));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) { /* try the next normalisation */ }
  }
  throw new Error("Could not read that config. Copy it again from Firebase console → Project settings → Your apps.");
}

const Backend = {
  enabled: false,
  ready: false,
  status: "offline",        // offline | connecting | online | error
  error: "",
  pending: 0,
  sdk: null,
  app: null, db: null, auth: null, fns: null,
  unsubs: [],
  reserved: [],             // voucher docs this device holds
  config: null,

  /* ---------------- config ---------------- */
  loadConfig() {
    let saved = null;
    try {
      const raw = storage.getItem(CLOUD_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) { /* unreadable store — fall through to the defaults */ }

    if (saved && saved.config) {
      this.config = saved.config;
      this.enabled = !!saved.enabled;
      return this.config;
    }

    // No local choice yet: adopt firebase-config.js if it is filled in.
    // Only autoConnect turns cloud mode on by itself, so an undeployed
    // backend cannot strand staff at a login they can never pass.
    const preset = typeof window !== "undefined" ? window.NEXUS_FIREBASE_CONFIG : null;
    if (preset && preset.apiKey && preset.projectId) {
      this.config = preset;
      this.enabled = !!preset.autoConnect;
      return this.config;
    }
    return null;
  },
  saveConfig(config, enabled) {
    this.config = config;
    this.enabled = enabled;
    storage.setItem(CLOUD_KEY, JSON.stringify({ config, enabled }));
  },
  clearConfig() {
    this.config = null;
    this.enabled = false;
    storage.removeItem(CLOUD_KEY);
  },

  /* ---------------- connection ---------------- */
  async connect() {
    if (!this.config) throw new Error("No Firebase configuration saved.");
    this.status = "connecting";
    const loadMod = (url) => new Function("url", "return import(url)")(url);
    const [appMod, authMod, storeMod, fnMod] = await Promise.all([
      loadMod(SDK("app")), loadMod(SDK("auth")), loadMod(SDK("firestore")), loadMod(SDK("functions")),
    ]).catch(() => {
      throw new Error("Could not load the Firebase SDK — this page may block external scripts, or you are offline for the first run.");
    });
    this.sdk = { app: appMod, auth: authMod, store: storeMod, fn: fnMod };

    this.app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(this.config);
    this.auth = authMod.getAuth(this.app);

    // Persistent cache = the till keeps working when the link drops.
    try {
      this.db = storeMod.initializeFirestore(this.app, {
        localCache: storeMod.persistentLocalCache({ tabManager: storeMod.persistentMultipleTabManager() }),
      });
    } catch (_) {
      this.db = storeMod.getFirestore(this.app);      // already initialised
    }
    this.fns = fnMod.getFunctions(this.app, this.config.functionsRegion || undefined);

    if (this.config.useEmulators) {
      const host = this.config.emulatorHost || "127.0.0.1";
      authMod.connectAuthEmulator(this.auth, `http://${host}:9099`, { disableWarnings: true });
      storeMod.connectFirestoreEmulator(this.db, host, 8080);
      fnMod.connectFunctionsEmulator(this.fns, host, 5001);
    }

    this.ready = true;
    this.status = "online";
    return true;
  },

  call(name, payload) {
    const callable = this.sdk.fn.httpsCallable(this.fns, name);
    return callable(payload || {}).then((r) => r.data);
  },

  /* ---------------- auth ---------------- */
  async bootstrap({ name, code, pin, siteName }) {
    await this.call("bootstrap", { name, code, pin, siteName });
    return this.signIn(code, pin);
  },

  async signIn(code, pin) {
    const res = await this.call("signIn", { code, pin });
    await this.sdk.auth.signInWithCustomToken(this.auth, res.token);
    this.uid = res.staff.id;
    return res.staff;
  },

  async signOut() {
    try { await this.call("releaseReservations"); } catch (_) { /* offline: reservations expire naturally */ }
    this.reserved = [];
    this.stopSync();
    if (this.auth) await this.sdk.auth.signOut(this.auth);
  },

  /* ---------------- sync ---------------- */
  // Mirrors every collection into `db` and re-renders on change.
  startSync(onChange) {
    const { store } = this.sdk;
    this.stopSync();
    let firstPass = 0;
    const total = Object.keys(COLLECTIONS).length;

    return new Promise((resolve) => {
      for (const [key, coll] of Object.entries(COLLECTIONS)) {
        const un = store.onSnapshot(store.collection(this.db, coll), (snap) => {
          db[key] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
          this.pending = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
          this.status = snap.metadata.fromCache && this.pending > 0 ? "offline" : "online";
          bumpRev();
          if (++firstPass >= total) resolve();
          if (onChange) onChange();
        }, (err) => {
          this.status = "error";
          this.error = err.message;
          if (++firstPass >= total) resolve();
          if (onChange) onChange();
        });
        this.unsubs.push(un);
      }
    });
  },

  stopSync() {
    this.unsubs.forEach((u) => { try { u(); } catch (_) {} });
    this.unsubs = [];
  },

  /* ---------------- writes ---------------- */
  put(key, obj) {
    const { store } = this.sdk;
    const coll = COLLECTIONS[key];
    if (!coll) return Promise.resolve();
    const data = Object.assign({}, obj);
    delete data.id;
    // setDoc resolves only once the server acks; offline that never happens,
    // so don't await it — the write is durably queued either way.
    store.setDoc(store.doc(this.db, coll, obj.id), data, { merge: true })
      .catch((e) => toast(`Sync rejected: ${e.message}`, "err"));
    return Promise.resolve();
  },

  drop(key, id) {
    const { store } = this.sdk;
    const coll = COLLECTIONS[key];
    if (!coll) return Promise.resolve();
    store.deleteDoc(store.doc(this.db, coll, id))
      .catch((e) => toast(`Delete rejected: ${e.message}`, "err"));
    return Promise.resolve();
  },

  newId() {
    const { store } = this.sdk;
    return store.doc(store.collection(this.db, "_ids")).id;
  },

  /* ---------------- voucher reservations ---------------- */
  // Top the device's block back up whenever it runs low and we're online.
  async topUp(siteId, type, count = 10) {
    if (!this.ready || !siteId) return;
    try {
      const res = await this.call("reserveVouchers", { siteId, type, count });
      const held = res.reserved || [];
      this.reserved = this.reserved.filter((v) => !(v.siteId === siteId && v.type === type)).concat(held);
    } catch (e) {
      // Offline or out of stock — fall back to whatever is already held.
      if (this.status === "online") this.error = e.message;
    }
  },

  // Read the block straight off the synced store, so it stays correct
  // whether the reservation was made on this device or another session.
  heldFor(siteId, type) {
    return db.vouchers.filter((v) =>
      v.siteId === siteId && v.type === type &&
      v.status === "available" && v.reservedBy === this.uid);
  },

  takeHeld(siteId, type) {
    const held = this.heldFor(siteId, type)
      .sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)));
    return held.length ? held[0] : null;
  },

  /* ---------------- diagnostics ---------------- */
  // Probes the project from the browser and names the exact broken piece.
  // Exists because every one of these faults surfaces in the UI as a bare
  // "internal", which points at nothing.
  async diagnose() {
    const cfg = this.config || {};
    const out = [];
    const add = (name, level, detail, fix) => out.push({ name, level, detail, fix: fix || "" });

    if (!cfg.projectId || !cfg.apiKey) {
      add("Configuration", "fail", "No Firebase config loaded", "Paste the web config in Admin → CLOUD, or fill in firebase-config.js");
      return out;
    }
    add("Project", "ok", cfg.projectId + (cfg.useEmulators ? " (emulators)" : ""), "");

    // Check the page can reach the network at all before blaming the backend.
    // Sandboxed previews (AI Studio, embedded frames) commonly allow scripts
    // from a CDN yet block fetch/XHR, and every Firebase call then fails
    // identically — which the SDK surfaces as a bare "internal".
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      add("Network", "fail", "This device is offline",
        "Reconnect and run diagnostics again. Local mode keeps selling meanwhile.");
      return out;
    }
    if (!cfg.useEmulators) {
      let framed = false;
      try { framed = window.top !== window.self; } catch (_) { framed = true; }
      try {
        await fetch(SDK("app"), { method: "GET", cache: "no-store" });
        add("Network access", "ok", "outbound requests allowed" + (framed ? " (inside a frame)" : ""), "");
      } catch (e) {
        add("Network access", "fail",
          "This page cannot make outbound requests" + (framed ? " — it is running inside an embedded preview frame" : ""),
          framed
            ? "Cloud mode needs direct network access. Open the deployed app in its own browser tab (Firebase Hosting, or npm run build then serve dist/) — an embedded preview blocks these calls."
            : "Something between this browser and Google is blocking requests — a content policy, extension, proxy or firewall. Try the deployed app in a normal browser tab, on another network, with extensions disabled.");
        add("Everything below", "warn", "Not checked — every backend call fails the same way while the network is blocked", "");
        return out;
      }
    }

    const emu = !!cfg.useEmulators;
    const host = cfg.emulatorHost || "127.0.0.1";
    const key = encodeURIComponent(cfg.apiKey);

    // --- Firestore database exists? ---
    try {
      const url = emu
        ? `http://${host}:8080/v1/projects/${cfg.projectId}/databases/(default)/documents/__diag__/probe`
        : `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/__diag__/probe?key=${key}`;
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      const msg = (j && j.error && j.error.message) || "";
      if (r.status === 404 && /does not exist/i.test(msg)) {
        add("Firestore database", "fail", "This project has no Firestore database",
          "Firebase console → Build → Firestore Database → Create database (production mode)");
      } else {
        add("Firestore database", "ok", emu ? "emulator reachable" : "exists — security rules active", "");
      }
    } catch (e) {
      add("Firestore database", "warn", "Could not reach Firestore: " + e.message, "Check the connection and try again");
    }

    // --- Authentication service enabled? ---
    // signInWithCustomToken with a junk token: INVALID_CUSTOM_TOKEN proves the
    // service is on; CONFIGURATION_NOT_FOUND proves it is not. Creates nothing.
    try {
      const url = emu
        ? `http://${host}:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`
        : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`;
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "diagnostic-probe", returnSecureToken: true }),
      });
      const j = await r.json().catch(() => ({}));
      const msg = (j && j.error && j.error.message) || "";
      if (/CONFIGURATION_NOT_FOUND/i.test(msg)) {
        add("Authentication", "fail", "Authentication is not enabled on this project",
          "Firebase console → Authentication → Get started → enable the Anonymous provider");
      } else if (r.ok || /INVALID_CUSTOM_TOKEN|MISSING_CUSTOM_TOKEN|INVALID_LOGIN_CREDENTIALS/i.test(msg)) {
        add("Authentication", "ok", "service enabled", "");
      } else {
        add("Authentication", "warn", msg || `HTTP ${r.status}`, "");
      }
    } catch (e) {
      add("Authentication", "warn", "Could not reach the Auth service: " + e.message, "");
    }

    // --- Each Cloud Function ---
    const region = cfg.functionsRegion || "us-central1";
    const base = emu
      ? `http://${host}:5001/${cfg.projectId}/${region}`
      : `https://${region}-${cfg.projectId}.cloudfunctions.net`;
    for (const fn of ["bootstrap", "signIn", "createStaff", "changePin", "resetPin", "reserveVouchers", "releaseReservations"]) {
      try {
        const r = await fetch(`${base}/${fn}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: '{"data":{}}',
        });
        const j = await r.json().catch(() => null);
        const ran = !!(j && j.error && (j.error.status || j.error.message));
        const em = ran ? String(j.error.message || j.error.status || "") : "";
        if (ran && /INTERNAL/i.test(String(j.error.status || ""))) {
          // the function executed and crashed — the log has the stack
          add(`Function ${fn}`, "fail", em || "Crashes when called",
            "See the stack: npx firebase-tools functions:log --only " + fn);
        } else if (ran || r.ok) {
          // any callable-protocol reply (invalid-argument, unauthenticated, …)
          // proves the function is deployed, reachable and executing
          add(`Function ${fn}`, "ok", em || `HTTP ${r.status}`, "");
        } else if (r.status === 404) {
          add(`Function ${fn}`, "fail", "Not deployed", "Run: bash deploy.sh");
        } else if (r.status === 403 || r.status === 401) {
          add(`Function ${fn}`, "fail", "Deployed, but callers are blocked (invoker permission)",
            "Re-run bash deploy.sh — it now grants public invoker access — or allow unauthenticated invocations on the Cloud Run service");
        } else {
          add(`Function ${fn}`, "warn", `Unexpected HTTP ${r.status}`, "");
        }
      } catch (e) {
        add(`Function ${fn}`, "fail", "Unreachable from this browser — not deployed, or invocation blocked before CORS headers are sent",
          "Run: bash deploy.sh, then: npx firebase-tools functions:list");
      }
    }
    return out;
  },

  /* ---------------- migration ---------------- */
  // Pushes this browser's local data up. Staff PINs cannot come along —
  // they were hashed for local use only — so agents get fresh PINs.
  async pushLocalData(local, onProgress) {
    const { store } = this.sdk;
    const report = { sites: 0, staff: 0, vouchers: 0, accounts: 0, sales: 0, payments: 0, closings: 0, pins: [] };
    const me = currentUser();

    const chunk = async (key, rows, transform) => {
      const coll = COLLECTIONS[key];
      for (let i = 0; i < rows.length; i += 400) {
        const batch = store.writeBatch(this.db);
        rows.slice(i, i + 400).forEach((row) => {
          const data = transform ? transform(row) : Object.assign({}, row);
          const id = data.id || row.id;
          delete data.id;
          batch.set(store.doc(this.db, coll, id), data, { merge: true });
        });
        await batch.commit();
        if (onProgress) onProgress(`${key}: ${Math.min(i + 400, rows.length)}/${rows.length}`);
      }
      report[key === "users" ? "staff" : key] = rows.length;
    };

    await chunk("sites", local.sites);
    // Existing cloud staff win; local-only staff arrive without a PIN and an
    // admin resets them, which is the only safe way to move credentials.
    const existingCodes = new Set(db.users.map((u) => u.code));
    const incoming = local.users.filter((u) => !existingCodes.has(u.code)).map((u) => ({
      id: u.id, name: u.name, code: u.code, role: u.role,
      siteIds: u.siteIds || [], status: u.status, createdAt: u.createdAt,
    }));
    for (const u of incoming) {
      try {
        const r = await this.call("createStaff", {
          name: u.name, code: u.code, role: u.role,
          siteIds: u.siteIds.length ? u.siteIds : (u.role === "agent" ? [local.sites[0] && local.sites[0].id].filter(Boolean) : []),
          pin: String(Math.floor(1000 + Math.random() * 9000)),
        });
        if (r && r.staffId) report.pins.push({ name: u.name, code: u.code, staffId: r.staffId });
      } catch (e) { /* duplicate code or invalid — skipped, reported below */ }
    }
    report.staff = incoming.length;

    await chunk("vouchers", local.vouchers, (v) => Object.assign({}, v, { reservedBy: v.reservedBy || null }));
    await chunk("accounts", local.accounts);
    // Sales must be attributed to a real cloud staff id; anything whose agent
    // did not come across is re-attributed to the importing admin.
    const cloudIds = new Set(db.users.map((u) => u.id).concat(incoming.map((u) => u.id)));
    await chunk("sales", local.sales, (s) => Object.assign({}, s, {
      agentId: cloudIds.has(s.agentId) ? s.agentId : (me ? me.id : s.agentId),
    }));
    await chunk("payments", local.payments, (p) => Object.assign({}, p, {
      receivedBy: cloudIds.has(p.receivedBy) ? p.receivedBy : (me ? me.id : p.receivedBy),
    }));
    await chunk("closings", local.closings);
    return report;
  },
};

if (typeof window !== "undefined") {
  window.Backend = Backend;
}

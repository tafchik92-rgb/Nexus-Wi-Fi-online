/* ============================================================
   NEXUS//POS — cloud backend adapter (Firebase)

   There is one shop and it lives on the server. This module loads the
   Firebase SDK, signs in through the signIn Cloud Function (the PIN is
   never checked in the browser), and mirrors Firestore into the
   in-memory `db` the UI reads — so every view, report and export works
   against live shared data.

   Selling requires a connection. A voucher is claimed inside a Firestore
   transaction that flips it from available to sold and writes the sale in
   the same commit, so two tills racing for the last code cannot both win:
   the loser sees the conflict and takes the next one. Firestore's cache
   keeps reads and reporting working through a brief drop, but a till that
   genuinely cannot reach the server says so instead of inventing stock.
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

// Firestore hands back Timestamps, GeoPoints and DocumentReferences, which
// carry references back into the SDK. Storing those raises "Converting
// circular structure to JSON" the moment anything serialises the store, and
// the app's date maths expects ISO strings anyway.
function plainDoc(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return undefined;
  if (typeof value.toDate === "function") return value.toDate().toISOString();      // Timestamp
  if (typeof value.latitude === "number" && typeof value.longitude === "number") {
    return { latitude: value.latitude, longitude: value.longitude };               // GeoPoint
  }
  if (value.firestore || value.path && value.id && value.parent) return value.path; // DocumentReference
  if (Array.isArray(value)) return value.map((v) => plainDoc(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const clean = plainDoc(v, depth + 1);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

const Backend = {
  ready: false,
  status: "offline",        // offline | connecting | online | error
  error: "",
  pending: 0,
  sdk: null,
  app: null, db: null, auth: null, fns: null,
  unsubs: [],
  config: null,
  uid: null,

  /* ---------------- config ---------------- */
  // Which Firebase project this till talks to. A config saved from the
  // CLOUD panel wins over the one shipped in firebase-config.js, so a shop
  // can be repointed without re-deploying the app.
  loadConfig() {
    let saved = null;
    try {
      const raw = storage.getItem(CLOUD_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) { /* unreadable store — fall through to the shipped config */ }

    if (saved && saved.config && saved.config.apiKey && saved.config.projectId) {
      this.config = saved.config;
      return this.config;
    }

    const preset = typeof window !== "undefined" ? window.NEXUS_FIREBASE_CONFIG : null;
    if (preset && preset.apiKey && preset.projectId) {
      this.config = preset;
      return this.config;
    }
    return null;
  },
  saveConfig(config) {
    this.config = config;
    storage.setItem(CLOUD_KEY, JSON.stringify({ config }));
  },
  clearConfig() {
    this.config = null;
    storage.removeItem(CLOUD_KEY);
  },

  /* ---------------- connection ---------------- */
  async connect() {
    if (!this.config) throw new Error("No Firebase configuration saved.");
    this.status = "connecting";
    const loadMod = (url) => new Function("url", "return import(url)")(url);

    // Firestore is by far the biggest module — around three quarters of the
    // SDK — and nothing on the sign-in screen touches it. Start it downloading
    // now but do not wait for it: signing in needs only app, auth and
    // functions, so the login form appears while the rest is still arriving.
    const storeLoading = loadMod(SDK("firestore"));
    storeLoading.catch(() => {});   // handled by ensureStore; don't warn twice

    const [appMod, authMod, fnMod] = await Promise.all([
      loadMod(SDK("app")), loadMod(SDK("auth")), loadMod(SDK("functions")),
    ]).catch(() => {
      throw new Error("Could not load the Firebase SDK — this page may block external scripts, or you are offline for the first run.");
    });
    this.sdk = { app: appMod, auth: authMod, store: null, fn: fnMod };

    this.app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(this.config);

    // Declare persistence at initialization rather than calling
    // setPersistence() afterwards: auth resolves "who is signed in" once
    // during init, so a later call has already missed that answer and only
    // migrates the state forward. Naming the stores here is what keeps an
    // agent signed in across a refresh mid-shift, whichever SDK build the
    // page happened to load.
    const stores = [authMod.indexedDBLocalPersistence, authMod.browserLocalPersistence].filter(Boolean);
    this.auth = null;
    if (authMod.initializeAuth && stores.length) {
      try {
        this.auth = authMod.initializeAuth(this.app, { persistence: stores });
      } catch (_) { /* already initialised for this app, or no storage at all */ }
    }
    if (!this.auth) this.auth = authMod.getAuth(this.app);

    this.fns = fnMod.getFunctions(this.app, this.config.functionsRegion || undefined);

    if (this.config.useEmulators) {
      const host = this.config.emulatorHost || "127.0.0.1";
      authMod.connectAuthEmulator(this.auth, `http://${host}:9099`, { disableWarnings: true });
      fnMod.connectFunctionsEmulator(this.fns, host, 5001);
    }

    // Wire Firestore up as soon as its module lands, without holding the
    // sign-in screen. Everything that touches it awaits ensureStore first.
    this._storeReady = storeLoading.then((storeMod) => this._initStore(storeMod));
    this._storeReady.catch(() => {});

    this.ready = true;
    this.status = "online";
    return true;
  },

  _initStore(storeMod) {
    this.sdk.store = storeMod;

    // Firestore may live in a NAMED database rather than "(default)" —
    // connecting to the wrong one simply times out with no useful error.
    const dbId = this.config.firestoreDatabaseId || undefined;

    // The persistent cache is for reads only — it makes the app start fast
    // and keeps reports and account lookups working through a brief drop.
    // Selling still needs the server (see claimAndSell). Long polling is
    // auto-detected because sandboxed frames and restrictive proxies often
    // break the streaming transport.
    try {
      this.db = storeMod.initializeFirestore(this.app, {
        localCache: storeMod.persistentLocalCache({ tabManager: storeMod.persistentMultipleTabManager() }),
        experimentalAutoDetectLongPolling: true,
      }, dbId);
    } catch (_) {
      try {
        // no IndexedDB (private mode, some frames) — trade offline reads for a connection
        this.db = storeMod.initializeFirestore(this.app, {
          localCache: storeMod.memoryLocalCache(),
          experimentalAutoDetectLongPolling: true,
        }, dbId);
      } catch (_) {
        this.db = storeMod.getFirestore(this.app, dbId);   // already initialised
      }
    }

    if (this.config.useEmulators) {
      storeMod.connectFirestoreEmulator(this.db, this.config.emulatorHost || "127.0.0.1", 8080);
    }
    return storeMod;
  },

  // Everything that reads or writes the database goes through here first, so
  // the deferred Firestore load — and the teardown that signing out performs —
  // are both invisible to callers.
  async ensureStore() {
    if (this.db) return this.sdk.store;
    // Signing out terminates the client to clear its cache; the next sign-in
    // builds a fresh one from the module we already have.
    if (!this._storeReady && this.sdk && this.sdk.store) {
      this._storeReady = Promise.resolve(this._initStore(this.sdk.store));
    }
    if (!this._storeReady) throw new Error("Not connected to the shop.");
    try {
      return await this._storeReady;
    } catch (_) {
      throw new Error("Could not load the database module — check the connection and reload.");
    }
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

  // Firebase Auth persists the signed-in staff member across reloads, so a
  // refresh mid-shift does not mean typing a PIN again. Returns the uid, or
  // null when nobody is signed in on this device.
  restoreSession() {
    if (!this.ready) return Promise.resolve(null);
    return new Promise((resolve) => {
      const un = this.sdk.auth.onAuthStateChanged(this.auth, (user) => {
        un();
        this.uid = user ? user.uid : null;
        resolve(this.uid);
      }, () => { un(); resolve(null); });
    });
  },

  async signOut() {
    this.stopSync();
    this.uid = null;

    // Wipe the local cache with the session. Firestore caches per database,
    // not per user, so on a shared till the next person to sign in was being
    // served the previous one's documents — including sites they have no
    // right to see, which the server had already refused them.
    const { store } = this.sdk || {};
    if (store && this.db) {
      const stale = this.db;
      this.db = null;
      this._storeReady = null;
      try {
        await store.terminate(stale);
        await store.clearIndexedDbPersistence(stale);
      } catch (_) {
        // memory cache, or another tab still holding it — nothing to purge
      }
    }

    if (this.auth) await this.sdk.auth.signOut(this.auth);
  },

  /* ---------------- sync ---------------- */
  // Which queries this staff member is actually allowed to run.
  //
  // Listening to a whole collection only works if every document in it is
  // readable. An admin can do that; an agent cannot, and the moment a second
  // site existed their listeners were refused wholesale — the app showed
  // SYNC ERROR and then quietly served whatever the previous user had left in
  // the local cache. So the queries are scoped to match the rules exactly,
  // using the same claims the rules read.
  syncPlan(role, mySites, uid) {
    const { store } = this.sdk;
    const plan = [];
    const add = (key, constraints) => plan.push({ key, coll: COLLECTIONS[key], constraints });

    if (role === "admin") {
      for (const key of Object.keys(COLLECTIONS)) add(key, []);
      return plan;
    }

    // Readable by any signed-in staff member, so no scoping needed.
    add("sites", []);
    add("users", []);

    // "in" takes at most 30 values; chunk so a widely-assigned agent still works.
    const chunks = [];
    for (let i = 0; i < mySites.length; i += 30) chunks.push(mySites.slice(i, i + 30));
    for (const key of ["vouchers", "accounts", "sales", "payments"]) {
      for (const chunk of chunks) add(key, [store.where("siteId", "in", chunk)]);
    }
    // An agent reads only their own closed months.
    add("closings", [store.where("userId", "==", uid)]);
    return plan;
  },

  // Mirrors the readable slice of every collection into `db` and re-renders on
  // change. This is also the gate the deferred Firestore load sits behind:
  // nothing reads or writes before sync starts, so awaiting the module here
  // covers put, drop, newId and the rest without making them all async.
  async startSync(onChange) {
    const store = await this.ensureStore();
    this.stopSync();

    const user = this.auth && this.auth.currentUser;
    if (!user) throw new Error("Not signed in.");
    // Take role and site scope from the token, not from any local record:
    // these are the very claims the security rules evaluate, so a query built
    // from them cannot ask for more than the rules will grant.
    const tok = await this.sdk.auth.getIdTokenResult(user);
    const role = tok.claims.role === "admin" ? "admin" : "agent";
    const mySites = Array.isArray(tok.claims.siteIds) ? tok.claims.siteIds : [];

    const plan = this.syncPlan(role, mySites, user.uid);
    // An agent with no site assignment has nothing site-scoped to read; leave
    // those collections empty rather than sending a query Firestore rejects.
    const streams = plan.filter((s) => !s.constraints.some((c) => c === null));

    // Several streams can feed one collection (one per site chunk), so each
    // keeps its own bucket and `db[key]` is the union.
    const buckets = new Map();
    for (const key of Object.keys(COLLECTIONS)) db[key] = [];

    const merge = (key) => {
      const seen = new Map();
      for (const [id, rows] of buckets) {
        if (!id.startsWith(key + "#")) continue;
        for (const row of rows) seen.set(row.id, row);
      }
      db[key] = [...seen.values()];
    };

    let firstPass = 0;
    const total = streams.length;
    if (!total) return;

    return new Promise((resolve) => {
      streams.forEach((s, i) => {
        const bucketId = `${s.key}#${i}`;
        const q = s.constraints.length
          ? store.query(store.collection(this.db, s.coll), ...s.constraints)
          : store.collection(this.db, s.coll);
        const un = store.onSnapshot(q, (snap) => {
          buckets.set(bucketId, snap.docs.map((d) => Object.assign({ id: d.id }, plainDoc(d.data()))));
          merge(s.key);
          this.pending = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
          this.status = snap.metadata.fromCache && this.pending > 0 ? "offline" : "online";
          bumpRev();
          if (++firstPass >= total) resolve();
          if (onChange) onChange();
        }, (err) => {
          this.status = "error";
          this.error = `${s.coll}: ${err.message}`;
          if (++firstPass >= total) resolve();
          if (onChange) onChange();
        });
        this.unsubs.push(un);
      });
    });
  },

  stopSync() {
    this.unsubs.forEach((u) => { try { u(); } catch (_) {} });
    this.unsubs = [];
  },

  /* ---------------- writes ---------------- */
  // put, drop and newId are only reachable once someone is signed in, which
  // means startSync has already awaited the Firestore module. The guard is
  // there so a mistake shows up as a clear message rather than a null deref.
  ready4store() {
    if (!this.db || !this.sdk.store) throw new Error("The database is still loading — try again in a moment.");
    return this.sdk.store;
  },

  put(key, obj) {
    const store = this.ready4store();
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

  // A targeted field write that must report whether the server accepted it —
  // unlike put, which fires and forgets. Used by the settlement repair, where
  // silently failing would leave the operator thinking it worked.
  async update(key, id, fields) {
    const store = this.ready4store();
    const coll = COLLECTIONS[key];
    if (!coll) throw new Error("Unknown collection: " + key);
    await store.updateDoc(store.doc(this.db, coll, id), fields);
  },

  // Deletes many documents at once, and reports what the server actually did.
  // A mistaken upload can be hundreds of codes; firing that many individual
  // deletes is slow and, worse, silent about the ones that were refused.
  async dropMany(key, ids) {
    const store = this.ready4store();
    const coll = COLLECTIONS[key];
    if (!coll) throw new Error("Unknown collection: " + key);
    let removed = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 400) {   // Firestore caps a batch at 500
      const slice = ids.slice(i, i + 400);
      const batch = store.writeBatch(this.db);
      slice.forEach((id) => batch.delete(store.doc(this.db, coll, id)));
      try {
        await batch.commit();
        removed += slice.length;
      } catch (_) {
        // One refusal fails the whole batch, so fall back to per-document
        // deletes and keep the ones the rules do allow.
        for (const id of slice) {
          try { await store.deleteDoc(store.doc(this.db, coll, id)); removed++; }
          catch (_) { failed++; }
        }
      }
    }
    return { removed, failed };
  },

  drop(key, id) {
    const store = this.ready4store();
    const coll = COLLECTIONS[key];
    if (!coll) return Promise.resolve();
    store.deleteDoc(store.doc(this.db, coll, id))
      .catch((e) => toast(`Delete rejected: ${e.message}`, "err"));
    return Promise.resolve();
  },

  newId() {
    const store = this.ready4store();
    return store.doc(store.collection(this.db, "_ids")).id;
  },

  /* ---------------- selling ---------------- */
  // Claims one voucher and books the sale in a single Firestore transaction.
  //
  // The transaction re-reads the voucher on the server before committing, so
  // if another till took it in the meantime this one aborts and we move to the
  // next candidate. That is what makes a shared stock safe without reserving
  // blocks per device: the server, not the client, decides who got the code.
  //
  // `makeSale(voucher)` builds the sale record from the voucher we won.
  // Throws OUT_OF_STOCK when the site has none left, CONTENDED when other
  // tills kept winning, DENIED when the server refused every attempt,
  // NO_CONNECTION when there is no link, or TIMEOUT when the server accepted
  // the attempt but never answered.
  async claimAndSell(siteId, type, makeSale) {
    if (!this.ready) throw new Error("NO_CONNECTION");
    await this.ensureStore();
    // Refuse before touching the server when the device knows it is offline.
    // A transaction cannot be queued, but it can sit retrying for a minute
    // with the agent staring at a spinner — and worse, commit later, after
    // they have given up and sold a second code to the same customer.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("NO_CONNECTION");
    }
    const { store } = this.sdk;

    // A live-looking link that never answers is the nastiest case: the SDK
    // keeps retrying well past the point the queue has noticed. Cap the wait
    // so the till says something, and say honestly that the outcome is
    // unknown rather than pretending nothing happened.
    const withDeadline = (work) => Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 12000)),
    ]);

    // Oldest stock first, so codes are issued in the order they were loaded.
    const queue = () => db.vouchers
      .filter((v) => v.siteId === siteId && v.type === type && v.status === "available")
      .sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)));

    const tried = new Set();
    let denied = 0;
    // Exhausting the candidates means either "nothing was there" or "everything
    // we reached for was refused" — and those need different advice.
    const giveUp = () => {
      if (!tried.size) return new Error("OUT_OF_STOCK");
      return new Error(denied === tried.size ? "DENIED" : "CONTENDED");
    };

    for (let attempt = 0; attempt < 8; attempt++) {
      const next = queue().find((v) => !tried.has(v.id));
      if (!next) throw giveUp();
      tried.add(next.id);

      const vRef = store.doc(this.db, COLLECTIONS.vouchers, next.id);
      try {
        return await withDeadline(store.runTransaction(this.db, async (tx) => {
          const snap = await tx.get(vRef);
          if (!snap.exists()) throw new Error("TAKEN");
          const fresh = Object.assign({ id: next.id }, plainDoc(snap.data()));
          if (fresh.status !== "available") throw new Error("TAKEN");

          const sale = makeSale(fresh);
          tx.update(vRef, { status: "sold", soldAt: sale.soldAt });
          const body = Object.assign({}, sale);
          delete body.id;
          tx.set(store.doc(this.db, COLLECTIONS.sales, sale.id), body);
          return sale;
        }));
      } catch (e) {
        const detail = String((e && e.code) || "") + " " + String((e && e.message) || e);
        if (/TIMEOUT/.test(detail)) throw e;      // the link is bad; retrying compounds it
        if (/TAKEN/.test(detail)) continue;                       // we saw it go first
        if (/aborted|already-exists|contention/i.test(detail)) continue;
        // Losing the race usually surfaces here: by the time the commit is
        // evaluated the voucher is already sold, so the rules' "status ==
        // available" no longer holds and the write comes back denied. Move to
        // the next code — but count it, because a genuine authorization fault
        // (wrong site, expired claims) is indistinguishable one attempt at a
        // time and must not be reported as mere bad luck.
        if (/permission[-_ ]denied|insufficient permissions/i.test(detail)) { denied++; continue; }
        if (/unavailable|deadline|network|offline|Failed to (get|fetch)/i.test(detail)) {
          throw new Error("NO_CONNECTION");
        }
        throw e;
      }
    }
    throw giveUp();
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
        "Reconnect and run diagnostics again — the till needs the server to issue a code.");
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
            ? "The app needs direct network access. Open the deployed app in its own browser tab (Firebase Hosting, or npm run build then serve dist/) — an embedded preview blocks these calls."
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
    for (const fn of ["bootstrap", "signIn", "createStaff", "changePin", "resetPin"]) {
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
  // One-way import of a till's old device-only store, from back when the app
  // kept its own records. Staff PINs cannot come along — they were hashed for
  // local use only — so agents get fresh PINs an admin hands out.
  async pushLocalData(local, onProgress) {
    const store = await this.ensureStore();
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

    // reservedBy is a leftover from the old per-device reservation scheme
    await chunk("vouchers", local.vouchers, (v) => {
      const out = Object.assign({}, v);
      delete out.reservedBy;
      delete out.reservedUntil;
      return out;
    });
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

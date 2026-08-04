/* ============================================================
   NEXUS//POS — which Firebase project this shop runs on

   The app has no local store: staff, stock and sales all live here. Fill
   this in and every till that loads the page is pointed at the same shop
   with nothing to configure. Leave it blank and the first screen asks an
   operator to paste the config instead.

   This is a plain script on purpose — do NOT add `type="module"` or an
   `import` here. The app's other scripts share globals, so a module
   would be scoped away from them, and calling Firebase's initializeApp()
   directly is unnecessary: backend.js initializes the SDK itself, with
   the read cache and emulator wiring the POS needs.

   The web config is public by design — it identifies the project, it
   does not grant access. Authorization comes from firestore.rules and
   the Cloud Functions.
   ============================================================ */
window.NEXUS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDWRlTwGnCBhOoItXIKCOCeEmLCgNcRQH0",
  authDomain: "gen-lang-client-0190547927.firebaseapp.com",
  projectId: "gen-lang-client-0190547927",
  storageBucket: "gen-lang-client-0190547927.firebasestorage.app",
  messagingSenderId: "999293040350",
  appId: "1:999293040350:web:6d140503aacf80abe4744f",

  // This project's Firestore lives in a NAMED database, not "(default)".
  // Without this the SDK talks to a database that does not exist and the
  // connection simply times out after ten seconds.
  firestoreDatabaseId: "ai-studio-nexuswifi-c56b2e13-8e06-41aa-bd40-1bd12d4dfe0f",
};

/* ============================================================
   NEXUS//POS — optional Firebase project defaults

   Fill this in to pre-configure cloud mode for every till, instead of
   pasting the config into Admin → CLOUD on each device. Delete the file
   (or leave the config null) to run purely in local mode.

   This is a plain script on purpose — do NOT add `type="module"` or an
   `import` here. The app's other scripts share globals, so a module
   would be scoped away from them, and calling Firebase's initializeApp()
   directly is unnecessary: backend.js initializes the SDK itself, with
   the offline cache and emulator wiring the POS needs.

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

  // Flip to true once `firebase deploy` has published the rules and
  // functions, and tills will connect to the cloud on load. Left false,
  // the config is merely pre-filled in Admin → CLOUD, one click away —
  // so a backend that is not ready yet can never lock staff out.
  autoConnect: false,
};

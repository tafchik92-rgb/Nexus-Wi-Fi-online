#!/usr/bin/env bash
# ============================================================
# NEXUS//POS — one-command backend deploy
#
# Enables the required Google Cloud APIs, installs dependencies and
# deploys Firestore rules, indexes and the Cloud Functions.
#
# Designed for Google Cloud Shell, where you are already authenticated —
# no keys to copy, nothing to paste. It also runs fine on your own
# machine once `firebase login` has been done.
#
#   bash deploy.sh                 # deploy everything
#   bash deploy.sh --rules-only    # just the security rules and indexes
#   bash deploy.sh --with-hosting  # also build and deploy the web app
# ============================================================
set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; CYN=$'\033[36m'; OFF=$'\033[0m'

say()  { printf '%s\n' "${CYN}▸ ${BOLD}$*${OFF}"; }
ok()   { printf '%s\n' "${GRN}  ✓ $*${OFF}"; }
warn() { printf '%s\n' "${YEL}  ! $*${OFF}"; }
die()  { printf '%s\n' "${RED}  ✗ $*${OFF}" >&2; exit 1; }

TARGETS="firestore:rules,firestore:indexes,functions"
WITH_HOSTING=0
for arg in "$@"; do
  case "$arg" in
    --rules-only)   TARGETS="firestore:rules,firestore:indexes" ;;
    --with-hosting) WITH_HOSTING=1 ;;
    -h|--help)      sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "Unknown option: $arg" ;;
  esac
done

cd "$(dirname "$0")"

# ---------- project ----------
say "Reading the project id"
# .firebaserc has no .json extension, so require() would treat it as JS
PROJECT="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(".firebaserc","utf8")).projects.default||"")' 2>/dev/null || true)"
[ -n "$PROJECT" ] || die "No project in .firebaserc — add one, or run: npx firebase-tools use --add"
ok "$PROJECT"

FB="npx --yes firebase-tools@latest"

# ---------- auth ----------
say "Checking Firebase authentication"
if $FB login:list 2>/dev/null | grep -qi "logged in"; then
  ok "already signed in"
elif [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  ok "using service-account credentials"
elif command -v gcloud >/dev/null && gcloud auth print-access-token >/dev/null 2>&1; then
  ok "using the Cloud Shell / gcloud session"
else
  warn "Not signed in — a browser sign-in follows (once per machine)"
  $FB login --no-localhost
fi

# ---------- APIs ----------
# Doing this up front avoids the interactive "enable this API?" prompts
# that stall a first deploy half way through.
if command -v gcloud >/dev/null; then
  say "Enabling the required Google Cloud APIs (safe to repeat)"
  gcloud services enable \
    cloudfunctions.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    run.googleapis.com \
    eventarc.googleapis.com \
    firestore.googleapis.com \
    firebaserules.googleapis.com \
    identitytoolkit.googleapis.com \
    iamcredentials.googleapis.com \
    --project "$PROJECT" --quiet 2>/dev/null && ok "APIs enabled" || {
      warn "Could not enable APIs automatically."
      warn "If the deploy fails with a 403, enable them once in the console and re-run."
    }
else
  warn "gcloud not found — the first deploy may ask to enable APIs. Answer yes."
fi

# ---------- token signing ----------
# Gen-2 functions run as the compute service account, which by default
# cannot sign the custom tokens signIn issues. Without this the app fails
# with a bare "internal" on first sign-in.
if command -v gcloud >/dev/null; then
  say "Allowing the functions to sign sign-in tokens"
  NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
  if [ -n "$NUM" ]; then
    RUNTIME_SA="$NUM-compute@developer.gserviceaccount.com"
    gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
      --member="serviceAccount:$RUNTIME_SA" \
      --role="roles/iam.serviceAccountTokenCreator" \
      --project "$PROJECT" --quiet >/dev/null 2>&1 \
      && ok "$RUNTIME_SA can sign tokens" \
      || warn "Could not grant Service Account Token Creator — grant it by hand if sign-in fails"
    # writing Firestore from the functions
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="serviceAccount:$RUNTIME_SA" \
      --role="roles/datastore.user" --condition=None --quiet >/dev/null 2>&1 \
      && ok "Firestore access granted" || true
  else
    warn "Could not read the project number — skipping the IAM grant"
  fi
fi

# ---------- dependencies ----------
say "Installing function dependencies"
npm install --prefix functions --no-audit --no-fund --silent
ok "done"

# ---------- optional hosting build ----------
if [ "$WITH_HOSTING" = "1" ]; then
  say "Building the web app"
  npm install --no-audit --no-fund --silent
  npm run build --silent
  ok "dist/ built"
  TARGETS="$TARGETS,hosting"
fi

# ---------- deploy ----------
say "Deploying: $TARGETS"
printf '%s\n' "${DIM}  First run takes 3-5 minutes while the functions build.${OFF}"
$FB deploy --only "$TARGETS" --project "$PROJECT" --non-interactive --force

# ---------- public invoker ----------
# Callable functions must accept unauthenticated HTTP callers (the app's own
# auth happens inside the call). firebase-tools normally sets this, but org
# policies can strip it — and the failure then looks like a bare "internal".
if command -v gcloud >/dev/null; then
  say "Ensuring the functions accept callers"
  for FN in bootstrap signin createstaff changepin resetpin reservevouchers releasereservations; do
    gcloud functions add-invoker-policy-binding "$FN" \
      --region="us-central1" --member="allUsers" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
  done
  ok "invoker policy checked"
fi

# ---------- verify ----------
# Probe each function over plain HTTP: a 400 invalid-argument reply proves it
# is deployed, reachable and executing. Anything else is named right here.
say "Verifying the deployed functions"
VERIFY_FAIL=0
for FN in bootstrap signIn createStaff changePin resetPin reserveVouchers releaseReservations; do
  CODE="$(curl -s -o /tmp/fn_probe -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d '{"data":{}}' \
    "https://us-central1-$PROJECT.cloudfunctions.net/$FN" 2>/dev/null || echo 000)"
  BODY="$(head -c 200 /tmp/fn_probe 2>/dev/null || true)"
  case "$CODE" in
    400|401) ok "$FN is live" ;;
    404)     warn "$FN NOT FOUND — the deploy did not create it"; VERIFY_FAIL=1 ;;
    403)     warn "$FN is blocked (invoker permission)"; VERIFY_FAIL=1 ;;
    500)     warn "$FN crashes: $BODY"; VERIFY_FAIL=1 ;;
    000)     warn "$FN unreachable (network)"; VERIFY_FAIL=1 ;;
    *)       warn "$FN answered HTTP $CODE: $BODY"; VERIFY_FAIL=1 ;;
  esac
done
[ "$VERIFY_FAIL" = "0" ] && ok "all seven functions verified" \
  || warn "Some functions failed verification — run the app's Admin → CLOUD → RUN DIAGNOSTICS for details"

# ---------- what now ----------
cat <<EOS

${GRN}${BOLD}Backend deployed to ${PROJECT}${OFF}

${BOLD}Finish in the app:${OFF}
  1. Admin → CLOUD → CONNECT      ${DIM}(your config is already filled in)${OFF}
  2. Sign out, then "set up a new shop" to create the admin on the server
  3. PUSH LOCAL DATA TO CLOUD, then reset each agent's PIN under Team
  4. Once that all works, set ${BOLD}autoConnect: true${OFF} in firebase-config.js

${BOLD}If sign-in fails${OFF}, check these are on in the Firebase console:
  • Firestore Database created
  • Authentication → Sign-in method → ${BOLD}Anonymous${OFF} enabled
  • Billing on the Blaze plan (Cloud Functions require it)
EOS

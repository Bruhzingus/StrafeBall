#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================================
# Strafeball deploy script  (droplet: /usr/local/bin/update-strafeball.sh)
# ============================================================================
# The client (dist/) and server (server/dist/) are PREBUILT LOCALLY and committed
# to git (see DEPLOY.md). This droplet is a throttled 1-vCPU shared box where
# `vite build` takes ~8 minutes, so we do ZERO compilation here — we just pull
# the already-compiled artifacts and restart the game server.
#
# Flow: lock -> fetch -> ff-only pull -> (server deps only if lockfile changed)
#       -> pm2 restart. No npm build, ever.
#
# Static client: nginx serves /var/www/StrafeBall/dist directly; once `git pull`
# updates those files nginx picks them up on the next request (no reload needed).
# ============================================================================

APP_DIR="${APP_DIR:-/var/www/StrafeBall}"
SERVER_DIR="${SERVER_DIR:-/var/www/StrafeBall/server}"
BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-strafeball-server}"
LOG_FILE="${LOG_FILE:-/var/log/strafeball-update.log}"
LOCK_FILE="${LOCK_FILE:-/tmp/strafeball-update.lock}"

# Set FORCE_RESET=true to discard any local droplet changes and hard-match GitHub.
# Default (false) is safer: a diverged/dirty tree fails loudly instead of silently merging.
FORCE_RESET="${FORCE_RESET:-false}"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  # Append to the log file too, if it's writable (don't crash the deploy if it isn't).
  echo "$msg" >>"$LOG_FILE" 2>/dev/null || true
}

fail() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: update-strafeball.sh [options]

  (no args)        Pull latest committed build artifacts and restart the server.
  --in <delay>     Schedule this deploy to run later via `at` (e.g. --in 25min).
  --delay <delay>  Alias for --in.
  -h, --help       Show this help.

Environment overrides:
  BRANCH=main            Git branch to deploy.
  PM2_APP=strafeball-server  PM2 process name.
  FORCE_RESET=true       Hard-reset to origin/<branch> (discards local droplet changes).
EOF
}

schedule_later() {
  local delay="$1"
  command -v at >/dev/null 2>&1 || fail "'at' is not installed; cannot schedule (apt install at)."
  log "Scheduling deploy in $delay"
  echo "$(realpath "$0")" | at "now + $delay"
  exit 0
}

# Install RUNTIME deps for the server only, and only when the lockfile actually changed
# (so a normal deploy skips the slow npm install entirely). The client needs NO install
# here — its build is prebuilt in dist/ and is just static files.
install_server_deps_if_changed() {
  cd "$SERVER_DIR"

  # Did this pull change the server lockfile? Compare the new HEAD against the pre-pull SHA.
  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ] \
     && ! git -C "$APP_DIR" diff --quiet "$LOCAL_SHA" "$REMOTE_SHA" -- server/package-lock.json server/package.json; then
    log "Server deps changed — installing (production only)"
    if [ -f package-lock.json ]; then
      npm ci --omit=dev
    else
      npm install --omit=dev
    fi
  else
    log "Server deps unchanged — skipping install"
  fi
}

# ----------------------------------------------------------------------------
# Argument handling
# ----------------------------------------------------------------------------

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --in|--delay)
    [ -n "${2:-}" ] || fail "Missing delay value. Example: --in 25min"
    schedule_later "$2"
    ;;
esac

# ----------------------------------------------------------------------------
# Lock so two deploys cannot run at once
# ----------------------------------------------------------------------------

exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another Strafeball update is already running."

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

log "=========================================="
log "Starting Strafeball update (prebuilt artifacts — no on-droplet build)"
log "APP_DIR=$APP_DIR  SERVER_DIR=$SERVER_DIR  BRANCH=$BRANCH  PM2_APP=$PM2_APP  FORCE_RESET=$FORCE_RESET"
log "=========================================="

[ -d "$APP_DIR" ]    || fail "App directory does not exist: $APP_DIR"
[ -d "$SERVER_DIR" ] || fail "Server directory does not exist: $SERVER_DIR"
command -v git >/dev/null 2>&1 || fail "git is not installed"
command -v pm2 >/dev/null 2>&1 || fail "pm2 is not installed"

cd "$APP_DIR"

# ----------------------------------------------------------------------------
# Pull latest (including the committed dist/ + server/dist/ artifacts)
# ----------------------------------------------------------------------------

log "Current git status:"
git status --short | tee -a "$LOG_FILE" 2>/dev/null || git status --short

log "Fetching origin/$BRANCH"
git fetch origin "$BRANCH"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
log "Local SHA:  $LOCAL_SHA"
log "Remote SHA: $REMOTE_SHA"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  log "Already up to date. Restarting anyway to apply any env/process changes."
elif [ "$FORCE_RESET" = "true" ]; then
  log "Force-resetting to origin/$BRANCH (discarding local changes)"
  git reset --hard "origin/$BRANCH"
else
  log "Pulling latest changes (fast-forward only)"
  git pull --ff-only origin "$BRANCH" \
    || fail "ff-only pull failed — the droplet tree has diverged. Inspect it, or rerun with FORCE_RESET=true."
fi

# ----------------------------------------------------------------------------
# Server runtime deps (only if the lockfile changed) — NO build step
# ----------------------------------------------------------------------------

install_server_deps_if_changed

# Sanity check: the prebuilt server entry point must exist (catches a forgotten local prebuild).
SERVER_ENTRY="$SERVER_DIR/dist/server/src/index.js"
[ -f "$SERVER_ENTRY" ] \
  || fail "Missing prebuilt server entry $SERVER_ENTRY. Did you run 'npm run deploy:prebuild' and commit before pushing?"

# ----------------------------------------------------------------------------
# Restart the game server
# ----------------------------------------------------------------------------

log "Restarting PM2 app: $PM2_APP"
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP" --update-env
else
  log "PM2 app '$PM2_APP' not found — starting it fresh"
  ( cd "$SERVER_DIR" && pm2 start npm --name "$PM2_APP" -- start )
fi

pm2 save
log "Update complete."
pm2 list | tee -a "$LOG_FILE" 2>/dev/null || pm2 list
log "Done."

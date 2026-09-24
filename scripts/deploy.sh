#!/usr/bin/env bash
# Redeploy PTV-MCP from the git checkout it runs in: pull, install,
# migrate, restart. Intended as the Farcmd "Deploy: PTV-MCP" command.
#
#   scripts/deploy.sh            # deploy origin/main
#   DEPLOY_BRANCH=foo scripts/deploy.sh
#
# Environment (all optional):
#   DEPLOY_BRANCH            branch to deploy (default: main)
#   MIGRATION_DATABASE_URL   run migrations as this role instead of
#                            DATABASE_URL from .env (use when the app's own
#                            role can't create tables)
#   PTV_MCP_RESTART_CMD      command that restarts everything (e.g.
#                            "pm2 restart ptv-mcp"). When set, the script
#                            does not manage processes itself.
#   PTV_MCP_HEALTH_URL       API health check (default:
#                            http://127.0.0.1:${PORT:-5999}/health)
#   PTV_MCP_WEB_URL          web dev server check (default:
#                            http://127.0.0.1:5173/)
#
# Without PTV_MCP_RESTART_CMD the script runs the dev deployment itself:
#   - API: `npm run dev` (tsx watch). Started if not running, restarted
#     when dependencies changed; otherwise tsx watch reloads by itself.
#   - Web: `npm --prefix web run dev` (Vite, port 5173, which the public
#     domain points at). Restarted on every deploy, so it never serves
#     outdated pre-bundled dependencies.
# Both run detached (setsid nohup), logging to logs/api.log and logs/web.log.
# Running processes are found by their working directory, so ones started
# by hand before this script took over are replaced too.
set -euo pipefail

cd "$(dirname "$0")/.."
branch="${DEPLOY_BRANCH:-main}"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# `npm install` on the server rewrites package-lock.json; the committed
# lockfile is authoritative (npm ci below), so drop that drift.
for lockfile in package-lock.json web/package-lock.json; do
  if ! git diff --quiet -- "$lockfile"; then
    log "discarding local $lockfile changes"
    git checkout -- "$lockfile"
  fi
done

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "working tree has local changes; refusing to deploy over them:"
  git status --short --untracked-files=no
  exit 1
fi

before="$(git rev-parse HEAD)"
log "fetching origin/$branch"
git fetch --quiet origin "$branch"
git checkout --quiet "$branch"
git merge --quiet --ff-only "origin/$branch"
after="$(git rev-parse HEAD)"
log "at $(git log -1 --format='%h %s')"

if [ -d node_modules ] && git diff --quiet "$before" "$after" -- package.json package-lock.json; then
  log "dependencies unchanged; skipping npm ci"
else
  log "installing dependencies"
  npm ci --no-audit --no-fund
  api_deps_changed=1
fi

# The web UI is served from web/dist, so rebuild it whenever web/ changed
# since the commit it was last built from (recorded in web/.dist-commit).
built_from="$(cat web/.dist-commit 2>/dev/null || true)"
if [ -d web/dist ] && [ -n "$built_from" ] && git cat-file -e "$built_from^{commit}" 2>/dev/null \
  && git diff --quiet "$built_from" "$after" -- web; then
  log "web UI unchanged; skipping web build"
else
  if [ ! -d web/node_modules ] || [ -z "$built_from" ] \
    || ! git diff --quiet "$built_from" "$after" -- web/package.json web/package-lock.json 2>/dev/null; then
    log "installing web dependencies"
    npm --prefix web ci --no-audit --no-fund
  fi
  log "building web UI"
  npm --prefix web run build
  echo "$after" > web/.dist-commit
fi

log "running migrations"
if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
  DATABASE_URL="$MIGRATION_DATABASE_URL" npm run --silent db:migrate
else
  npm run --silent db:migrate
fi

if [ -f .env ]; then
  port="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- || true)"
fi
health_url="${PTV_MCP_HEALTH_URL:-http://127.0.0.1:${port:-${PORT:-5999}}/health}"
web_url="${PTV_MCP_WEB_URL:-http://127.0.0.1:5173/}"
repo="$(pwd -P)"
mkdir -p logs

# PIDs of processes whose command line matches $1 and whose working
# directory is $2.
find_pids() {
  local pattern="$1" dir="$2" pid
  for pid in $(pgrep -f -- "$pattern" || true); do
    [ "$pid" = "$$" ] && continue
    if [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$dir" ]; then
      echo "$pid"
    fi
  done
}

stop_pids() {
  local pids="$*" pid
  [ -z "$pids" ] && return 0
  # Kill each process's whole group, so npm wrappers and children go too.
  local own_pgid pgid
  own_pgid="$(ps -o pgid= $$ | tr -d ' ' || true)"
  for pid in $pids; do
    # The process may already be gone; that's fine.
    pgid="$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ' || true)"
    if [ -n "$pgid" ] && [ "$pgid" != "$own_pgid" ]; then
      kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for _ in $(seq 1 20); do
    local alive=""
    for pid in $pids; do if kill -0 "$pid" 2>/dev/null; then alive=1; fi; done
    [ -z "$alive" ] && return 0
    sleep 0.5
  done
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
}

start_detached() {
  local name="$1" dir="$2"
  shift 2
  log "starting $name: $* (log: logs/$name.log)"
  # exec setsid: the process gets its own session, and nothing here keeps
  # the deploy's stdout (Farcmd's SSH channel) open or waits for it.
  (cd "$dir" && exec setsid nohup "$@" >> "$repo/logs/$name.log" 2>&1 < /dev/null) \
    > /dev/null 2>&1 < /dev/null &
}

wait_for() {
  local name="$1" url="$2"
  log "waiting for $name at $url"
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null; then
      log "$name is up"
      return 0
    fi
    sleep 2
  done
  log "$name did not come up within 90s; see logs/$name.log"
  return 1
}

if [ -n "${PTV_MCP_RESTART_CMD:-}" ]; then
  log "restarting: $PTV_MCP_RESTART_CMD"
  eval "$PTV_MCP_RESTART_CMD"
  wait_for api "$health_url"
else
  api_pids="$(find_pids 'tsx.* watch src/server.ts' "$repo")"
  if [ -z "$api_pids" ]; then
    start_detached api "$repo" npm run dev
  elif [ -n "${api_deps_changed:-}" ]; then
    log "dependencies changed; restarting API"
    stop_pids $api_pids
    start_detached api "$repo" npm run dev
  else
    log "API running (tsx watch reloads code changes)"
  fi

  log "restarting web dev server"
  stop_pids $(find_pids 'vite' "$repo/web")
  start_detached web "$repo/web" npm run dev

  wait_for api "$health_url"
  wait_for web "$web_url"
fi

log "deployed $(git rev-parse --short HEAD)"

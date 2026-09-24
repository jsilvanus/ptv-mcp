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
#   PTV_MCP_RESTART_CMD      command that restarts the server, e.g.
#                            "systemctl restart ptv-mcp" or
#                            "pm2 restart ptv-mcp". If unset, the running
#                            `tsx watch` picks up the new code by itself.
#   PTV_MCP_HEALTH_URL       checked after restart (default:
#                            http://localhost:${PORT:-5999}/health)
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

if [ -n "${PTV_MCP_RESTART_CMD:-}" ]; then
  log "restarting: $PTV_MCP_RESTART_CMD"
  eval "$PTV_MCP_RESTART_CMD"
else
  log "no PTV_MCP_RESTART_CMD; relying on tsx watch to reload"
fi

if [ -f .env ]; then
  port="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- || true)"
fi
health_url="${PTV_MCP_HEALTH_URL:-http://localhost:${port:-${PORT:-5999}}/health}"
log "waiting for $health_url"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$health_url" >/dev/null 2>&1; then
    log "healthy; deployed $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done
log "server did not become healthy within 60s"
exit 1

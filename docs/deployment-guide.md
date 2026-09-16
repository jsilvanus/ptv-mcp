# Deployment guide (Phase 6 / MVP-0)

This guide finalizes Phase 6 deployment requirements:

- `docker-compose.yml` is for **dev/staging** and includes in-stack Postgres.
- Production uses **external Postgres** via `DATABASE_URL` (and optional external object storage if needed).
- Production container serves both API and built web UI (`web/dist`) from the same process.

## 1) Build and publish image

CI (`.github/workflows/deploy.yml`) builds and pushes:

- `ghcr.io/<owner>/<repo>:latest` (default branch)
- `ghcr.io/<owner>/<repo>:sha-...`

You can also build locally:

```bash
docker build -t ghcr.io/<owner>/<repo>:<tag> .
```

## 2) Required production environment variables

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=3000`
- `DATABASE_URL` (external Postgres)
- `MASTER_ENCRYPTION_KEY`
- `JWT_SECRET`
- Optional v11 OAuth client values:
  - `PTV_V11_OAUTH_CLIENT_ID`
  - `PTV_V11_OAUTH_CLIENT_SECRET`
  - `PTV_V11_OAUTH_REDIRECT_URI`

## 3) Run database migrations

Run once for each deploy target:

```bash
npm run db:migrate
```

## 4) Run with production compose

Use `docker-compose.production.yml` (no bundled Postgres):

```bash
docker compose -f docker-compose.production.yml up -d
```

## 5) Verify rollout

- `GET /health` returns 200
- Login works in web UI
- Tenant-scoped API calls work with expected RBAC
- MCP tools are reachable on `/mcp`

## 6) Staged `PtvV11Adapter` write rollout

Enable write support tenant-by-tenant by controlling the tenant's `ptv_adapter_configs.supports_write` in production:

1. Start with pilot tenant(s) only.
2. Verify propose → validate → apply and audit-chain behavior.
3. Expand to the next tenant batch.
4. Keep manual export (`ptv_export_for_manual_publish`) available for non-enabled tenants.

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
- `JWT_SECRET` (base64, at least 32 bytes decoded)
- `DATABASE_URL` must use a role that is not a superuser and has no `BYPASSRLS`
  (else startup is refused; opt out with `ALLOW_PRIVILEGED_DB_ROLE=true`)
- Optional v11 OAuth client values:
  - `PTV_V11_OAUTH_CLIENT_ID`
  - `PTV_V11_OAUTH_CLIENT_SECRET`
  - `PTV_V11_OAUTH_REDIRECT_URI`
- `DOMAIN_PATH`: optional public path prefix. Unset or `/` installs at the domain root; `/ptv-mcp` installs under that path. Traefik strips the prefix before forwarding, while the UI, OAuth and MCP public URLs retain it.
- `MCP_PUBLIC_URL`: the public URL (MCP OAuth issuer, and the base of the
  OIDC redirect URI `<MCP_PUBLIC_URL>/oidc/callback`)
- `ALLOW_TENANT_CREATION`: default `true`, so any signed-in account can create
  an organisation with `POST /tenants`. Set `false` in production: the route
  then answers 403. See "Creating tenants" below.
- Optional single sign-on (README, "Single sign-on"; off while
  `OIDC_ISSUER` is empty):
  - `OIDC_ISSUER` (https in production), `OIDC_CLIENT_ID`,
    `OIDC_CLIENT_SECRET`
  - `OIDC_SCOPES`, `OIDC_BUTTON_LABEL`, `OIDC_CREATE_USERS`,
    `OIDC_TRUST_EMAIL`

## 3) Run database migrations

Run once for each deploy target:

```bash
npm run db:migrate
```

### Creating tenants

With `ALLOW_TENANT_CREATION=false`, an operator creates each tenant. The
account must already exist (register it first); it becomes the tenant's first
Tenant Admin:

```bash
# From a checkout (dev dependencies installed):
npm run tenant:create -- --name "Example parish" --slug example-parish --admin-email admin@example.org

# In the production container, which has no dev dependencies, from the compiled build:
node dist/tenants/createTenant.js --name "Example parish" --slug example-parish --admin-email admin@example.org
```

The command uses the same code path as `POST /tenants` (it does not depend on
the flag), so it works whether the route is on or off.

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

## Deploying to the shared VPS (GitHub Actions)

The shared riksunsrk VPS runs ptv-mcp behind the shared Traefik, against the shared
Postgres (`pg.shared.local`). Infrastructure is in `riksunsrk/infra`; this repo owns
the image and `deploy/docker-compose.yml`.

### Flow

1. **Push to `main`** builds and pushes `ghcr.io/jsilvanus/ptv-mcp:sha-<short sha>` (and
   `latest`). It does not deploy.
2. **Manual run of "Deploy"** (Actions, `workflow_dispatch`) builds and pushes the image
   again from the selected ref, then waits for approval on the `production` environment,
   and deploys that `sha-` tag. Deploys are serialised (`deploy-production`, no cancel).
   A deployment agent triggers this on purpose; pushes never deploy.

The deploy job copies `deploy/docker-compose.yml` to `DEPLOY_PATH`, provisions the app's
role and database, writes a `chmod 600` `.env`, pulls, runs `docker compose up -d`, waits
for the container healthcheck, and checks `https://<DOMAIN><DOMAIN_PATH>/health` (`DOMAIN_PATH` is omitted for root installs).

### Migrations

Migrations run as the one-shot `migrate` service (`node dist/db/migrate.js`, restart
`no`). The `app` service starts only after `migrate` exits 0. A failed migration stops the
deploy before the new app starts. Re-running `up` re-runs `migrate`, which does nothing
when no migration is pending.

### GitHub `production` environment

Secrets (required unless noted):

- `SSH_PRIVATE_KEY`, `GHCR_TOKEN` (read:packages on the image)
- `DB_PASSWORD` (password for the app's Postgres role), `DB_SUDO_PASSWORD` (infra
  Postgres superuser)
- `MASTER_ENCRYPTION_KEY`, `JWT_SECRET` (base64, at least 32 bytes decoded)
- optional: `OIDC_CLIENT_SECRET`, `PTV_V11_OAUTH_CLIENT_SECRET`

Variables:

- required: `VM_HOST`, `VM_USER`, `DEPLOY_PATH` (app directory on the VPS),
  `DEPLOY_DB_PATH` (the `riksunsrk/infra` database directory), `APP_NAME` (e.g. `ptv_mcp`,
  which gives role `ptv_mcp_user` and database `ptv_mcp_db`), `DOMAIN`
- optional: `DOMAIN_PATH` (default `/`; e.g. `/ptv-mcp`), `VM_SSH_PORT` (default 22), `GHCR_USER` (default: the triggering actor; must
  own `GHCR_TOKEN`), `LOG_LEVEL`, and the optional auth variables (`AUTH_MODE`,
  `OIDC_*`, `REQUIRE_VERIFIED_EMAIL`, `PTV_V11_OAUTH_CLIENT_ID`,
  `PTV_V11_OAUTH_REDIRECT_URI`); see the workflow header for the full list

`MCP_PUBLIC_URL` is set to `https://<DOMAIN><DOMAIN_PATH>` automatically, omitting the path when `DOMAIN_PATH` is `/` or unset. `NODE_ENV=production`,
`HOST=0.0.0.0`, and `PORT=3000` are fixed in the `.env`.

### First-time cluster step: the `ptv_mcp_app` role

Migrations `GRANT` table privileges to the cluster role `ptv_mcp_app`, so it must exist
before the first migration. The deploy job creates it idempotently (`CREATE ROLE ... NOLOGIN
NOBYPASSRLS` if missing), so no manual step is normally needed. To do it by hand on the
shared Postgres (as the superuser), use the same statement as `scripts/bootstrap-roles.sql`,
but `NOLOGIN`.

### Tenants in production

Set `ALLOW_TENANT_CREATION=false`. The deploy always writes it as `false`, so `POST /tenants`
answers 403. Create tenants with the operator tool inside the running container. The
account must already exist:

```bash
docker exec ptv-mcp-app node dist/tenants/createTenant.js \
  --name "Example parish" --slug example-parish --admin-email admin@example.org
```

### Metrics

ptv-mcp does not expose `/metrics` yet, so there is no Prometheus scrape job to add in
`riksunsrk/infra`. Add the endpoint, bearer-token gated, before adding a scrape job.

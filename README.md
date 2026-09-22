# ptv-mcp

Palvelutietovarannon käyttöön tarkoitettu MCP

A multi-tenant MCP server bridging Suomi.fi Palvelutietovaranto (PTV) and
AI agents. See [`docs/plan.md`](./docs/plan.md) for the architecture,
[`docs/phase-plan.md`](./docs/phase-plan.md) for the build sequence,
[`docs/ptv-v11-notes.md`](./docs/ptv-v11-notes.md) and
[`docs/ptv-v12-notes.md`](./docs/ptv-v12-notes.md) for the PTV v11/v12 API
findings, [`docs/deployment-guide.md`](./docs/deployment-guide.md) for
deployment, and
[`docs/adapter-onboarding-runbook.md`](./docs/adapter-onboarding-runbook.md)
for new adapter bring-up. `PLAN.md` and `EXECUTION_LOG.md` track live
implementation progress against the phase plan — both adapters
(`PtvV11Adapter`, `PtvV12Adapter`) are live side by side today; see
`PLAN.md`'s Phase 9 entry for the current state and known gaps.

## Local development

Requires Node.js 22+ and a PostgreSQL 16 instance.

```bash
cp .env.example .env    # fill in MASTER_ENCRYPTION_KEY for local dev
npm install
```

Database setup (once per fresh database):

```bash
# One-time, requires a superuser (or CREATEROLE) connection —
# never run as the application's own DB role. See the file itself.
psql -h localhost -U <superuser> -d ptv_mcp_dev -f scripts/bootstrap-roles.sql

npm run db:migrate
npm run db:seed   # optional: local dev fixtures
```

Or via Docker Compose, which runs the bootstrap script automatically:

```bash
docker compose up
```

## PTV v12 raw-response debugging

Set `PTV_V12_DEBUG_RAW=true` to print successful v12 API responses to the
server console before they are mapped into the MCP domain model. This is
intended for temporary integration debugging; responses can contain public
PTV content and should not be enabled in routine production operation.

## Production

- Use `docker-compose.production.yml` for production container runtime.
- Production database is external (`DATABASE_URL`), not bundled in compose.
- CI/CD image build + publish workflow: `.github/workflows/deploy.yml`.

Common tasks:

```bash
npm run dev              # start the API with hot reload
npm test                 # unit tests (no DB required)
npm run test:integration # RLS / DB-backed tests (requires a migrated DB)
npm run lint
npm run typecheck
npm run build
```

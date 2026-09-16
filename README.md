# ptv-mcp

Palvelutietovarannon käyttöön tarkoitettu MCP

A multi-tenant MCP server bridging Suomi.fi Palvelutietovaranto (PTV) and
AI agents. See [`docs/plan.md`](./docs/plan.md) for the architecture,
[`docs/phase-plan.md`](./docs/phase-plan.md) for the build sequence, and
[`docs/ptv-v11-notes.md`](./docs/ptv-v11-notes.md) for the PTV v11 API
findings. `PLAN.md` and `EXECUTION_LOG.md` track live implementation
progress against the phase plan.

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

Common tasks:

```bash
npm run dev              # start the API with hot reload
npm test                 # unit tests (no DB required)
npm run test:integration # RLS / DB-backed tests (requires a migrated DB)
npm run lint
npm run typecheck
npm run build
```

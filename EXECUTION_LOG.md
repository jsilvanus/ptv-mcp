# Execution Log — PTV MCP Server

Append-only. See `PLAN.md` for current checklist state and
`docs/phase-plan.md` for full phase rationale.

---

## 2026-09-16 — Phase 0 closed ✅ 🔒

Owned files:
- package.json, package-lock.json
- tsconfig.json
- eslint.config.js, .prettierrc.json, .prettierignore
- .gitignore, .env.example
- src/config.ts
- src/app.ts
- src/server.ts
- src/routes/health.ts
- src/routes/health.test.ts
- Dockerfile, docker-compose.yml
- .github/workflows/ci.yml

Sync point verified (Phase 0 checklist from the phase-execution skill):
- [x] Clean-clone equivalent: `rm -rf node_modules dist && npm install` then
      `format`/`lint`/`typecheck`/`test`/`build` all pass from scratch.
- [x] Env vars documented in `.env.example` (`NODE_ENV`, `HOST`, `PORT`,
      `LOG_LEVEL`, `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`).
- [x] DB connection verified — not just configured: started a local
      PostgreSQL 16 cluster (no Docker daemon available in this sandbox;
      documented as a known limitation below) and created the `ptv_mcp_dev`
      database/role, confirmed with `psql ... SELECT current_user,
      current_database()`.
- [x] Docker Compose config validated with `docker compose config` (daemon
      itself unavailable in this sandbox, so containers were not started —
      see deviation below).
- [x] Smoke test: built `dist/server.js`, ran it, `curl
      http://localhost:3000/health` returned `{"status":"ok"}` / HTTP 200.
      Also covered by an automated Vitest test using `app.inject()`.

Deviations:
- The sandbox this session runs in has the Docker CLI but no running
  daemon (`/var/run/docker.sock` absent). `docker-compose.yml` and
  `Dockerfile` are written and the compose file's syntax/interpolation was
  validated with `docker compose config`, but the actual container build
  and `depends_on: service_healthy` behavior have **not** been run
  end-to-end. Postgres connectivity was instead verified against a local
  `postgresql-16` install in the sandbox. This should be re-verified with
  a real `docker compose up` the first time this repo is built somewhere
  with a working Docker daemon (e.g. CI, or a developer's machine).
- Picked Fastify's own `@fastify/sensible` for baseline HTTP error helpers
  (not in the original phase plan's explicit step list, but implied by
  "Fastify app skeleton" and needed almost immediately once real routes
  arrive) — no `@fastify/env` plugin used; config loading is a small
  hand-written `loadConfig()` instead, since the validation needs
  (required-var enforcement, typed `NODE_ENV` union) were simple enough
  not to warrant a schema-plugin dependency yet. Revisit if config grows
  more complex in later phases.
- Bumped `vitest` from the originally-drafted `^3.0.2` to `^5.0.1` before
  first install, after `npm audit` flagged a moderate path-traversal
  advisory in `@vitest/mocker` on the 3.x/4.x line — starting clean rather
  than accepting a known dev-dependency vulnerability on day one.

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

---

## 2026-09-16 — Phase 1, Stream A (Data layer) closed ✅ 🔒

Owned files:
- src/db/schema/enums.ts, user.ts, tenant.ts, membership.ts,
  tenantEnvironment.ts, ptvAdapterConfig.ts, userPtvConnection.ts,
  auditEntry.ts, index.ts
- src/db/client.ts, src/db/migrate.ts, src/db/seed.ts
- src/db/rls.integration.test.ts
- drizzle.config.ts
- drizzle/0000_right_chameleon.sql, drizzle/0001_row_level_security.sql,
  drizzle/meta/*
- scripts/bootstrap-roles.sql
- vitest.config.ts (added to stop the compiled `dist/` output from being
  re-discovered as its own duplicate test suite)

Tooling: added `drizzle-orm`, `postgres`, `drizzle-kit` (dev), and
`@node-rs/argon2` (for the seed script's password hash — the real Argon2id
login flow is Phase 3's concern).

Sync point verified (Phase 1's stated goal: "migrations run clean on a
fresh Postgres"):
- [x] Dropped and recreated `ptv_mcp_dev` from scratch, ran
      `scripts/bootstrap-roles.sql` then `npm run db:migrate` end to end —
      no manual intervention beyond those two steps.
- [x] `pg_class.relrowsecurity`/`relforcerowsecurity` confirmed `t`/`t` on
      all five RLS-protected tables.
- [x] Automated integration test (`npm run test:integration`, 4 tests) run
      against the real `ptv_mcp_app` role — not just `ptv_mcp` the owner —
      proving: (a) zero rows visible with no session context set (fail
      closed), (b) exactly the current tenant's `audit_entries` visible
      once `app.current_tenant_id` is set, (c) no cross-tenant leakage
      when both tenants have rows, (d) `user_ptv_connections` scoped by
      `app.current_user_id`, independent of any tenant context.
- [x] `npm run db:seed` runs cleanly against the migrated DB and produces
      the expected two tenants / one cross-tenant user / two membership
      rows (verified by querying with the correct tenant context set).

Deviations:
- **RLS session-variable mechanism**: the plan's own text used `SET LOCAL
  app.current_tenant_id = '<uuid>'` as the illustrative example. That
  turned out not to be parameterizable (`SET LOCAL ... = $1` is a Postgres
  syntax error), so all application-side code — the integration test and
  the seed script — uses `SELECT set_config('app.current_tenant_id', $1,
  true)` instead, which is the parameterized-safe equivalent and behaves
  identically for RLS purposes. **Phase 3's tenant resolver must use
  `set_config()`, not literal `SET LOCAL`, when it wires this up for
  real.**
- **Role bootstrap moved out of the migration chain.** The original
  intent was for the RLS migration to create the `ptv_mcp_app` role
  itself. Postgres correctly refused: the migration-owning role has no
  `CREATEROLE` privilege (and shouldn't — it's a broad, dangerous grant
  with no other purpose here). Added `scripts/bootstrap-roles.sql`, a
  separate one-time step run by a superuser, wired into
  `docker-compose.yml` via `docker-entrypoint-initdb.d` for the Compose
  path and documented as an explicit manual step (and a CI step) for
  everywhere else. This is a **new prerequisite**: `npm run db:migrate`
  will fail with a permissions error against any database where this
  bootstrap hasn't run first.
- Extended `.github/workflows/ci.yml` (a Phase 0 file) with a Postgres
  service container, the bootstrap step, `db:migrate`, and
  `test:integration` — Phase 0 was locked before Phase 1 Stream A's DB
  work existed to test, so CI necessarily grows here. Treating this as an
  expected, additive extension of a locked phase's file rather than a
  reopen, since it adds new steps rather than changing or invalidating
  anything Phase 0 verified.
- Split `npm test` (fast, no DB) from `npm run test:integration` (DB
  required) rather than one combined `test` script, so contributors
  without a local Postgres running can still get fast feedback.
- Accepted, not fixed: `npm audit`'s moderate `esbuild`/`@esbuild-kit`
  advisory via `drizzle-kit`'s dev-only config loader (affects a local
  dev server's request handling; not shipped to production; fixing would
  mean downgrading `drizzle-kit` to `0.18.1`, a much larger regression
  than the advisory's real-world risk here).

---

## 2026-09-16 — Phase 1, Stream B (`PtvAdapter` contract and domain model) closed ✅ 🔒

Owned files:
- src/ptv/domain.ts
- src/ptv/adapter.ts
- src/ptv/registry.ts
- src/ptv/contract.test.ts
- src/ptv/testing/inMemoryAdapter.ts
- src/ptv/testing/contractTests.ts

Sync point verified (Phase 1's stated goal: "the PtvAdapter interface and
domain model compile and are documented; the contract test suite runs
against a fake in-memory adapter and is ready to run against real
implementations"):
- [x] `npm run typecheck`, `lint`, `format`, and `build` all pass.
- [x] `runPtvAdapterContractTests` (13 assertions) executed twice against
      `InMemoryPtvAdapter` — once configured as `supportsWrite: true`
      (tenant-scoped), once as `supportsWrite: false` (user-scoped) — 26
      tests total, all passing, confirming the suite correctly exercises
      both the write-capable and read-only branches of
      `applyServiceChange`'s contract.
- [x] Domain model and `PtvAdapter` interface reviewed against the actual
      field-level findings in docs/ptv-v11-notes.md (3 service subtypes,
      5 channel subtypes, `publishingStatus`, connections with no
      dedicated v11 read endpoint) rather than only the phase plan's
      prose summary.

Both Phase 1 streams are now closed — **Phase 1 as a whole is done.**
Sync point for the phase (`npm run db:migrate` succeeds on a fresh
Postgres; a real v12 search call was not yet made — that's Phase 2's
`PtvV12Adapter`, not Phase 1's domain-model-only scope) is met.

Deviations:
- `PtvAdapter`'s methods take no explicit auth/context parameters —
  `PtvAdapterRegistry.resolve()` hands back an already-credentialed
  instance. The phase plan didn't spell this division of responsibility
  out explicitly; recorded here so Phase 3 Stream D's registry
  implementation and Phase 2's two adapters agree on it without
  re-deriving it from scratch.
- Domain model fields are pragmatically scoped to what Phase 4's tool
  layer needs (search/get/propose/validate/export/apply), not a
  field-for-field mirror of either wire format's full schema. Adapters
  are free to carry additional version-specific detail internally as long
  as they map cleanly to/from this shape at the boundary.

---

## 2026-09-16 — Plan amendment: v11-first sequencing (user directive)

Per explicit user instruction: `PtvV11Adapter` and `PtvV12Adapter` are no
longer built side by side. What was "Phase 2, Stream 2A (`PtvV12Adapter`)"
is removed from Phase 2 entirely and becomes its own new phase, inserted
after the old Phase 6 (MVP-0 launch). What were Phase 7/8 (MVP-1/MVP-2)
are renumbered to Phase 8/9. Phase 0 and Phase 1 are **unaffected and
remain locked** — both were already built version-agnostic/polymorphic
(the `PtvAdapter` interface, domain model, and `TenantEnvironment` +
`UserPtvConnection` schema make no assumption about which adapter is
built first), so nothing about this resequencing invalidates their sync
points or requires reopening them.

Updated: `docs/plan.md` (MVP-0/v12-integration/MVP-1/MVP-2 sections,
"Vaiheistus"), `docs/phase-plan.md` (full rewrite — 10 phases now, was 9),
`PLAN.md` (checklist restructured to match).

Rationale recorded in docs/phase-plan.md's revision note: v11 alone is a
complete, real-production-writing MCP server; building it alone first
ships sooner than coordinating two adapters at once for a v12 write
capability that doesn't exist yet on PTV's side regardless. New risk
introduced and recorded in the phase plan's risk register: MVP-0 now
depends on a single point of PTV integration rather than having v12 as an
immediate fallback.

Now resuming execution at Phase 2 (`PtvV11Adapter` implementation, the new
single-adapter scope) — the next entry will cover its actual sync point
verification.

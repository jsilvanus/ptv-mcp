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

---

## 2026-09-16 — Phase 1 reopened: `CodeListEntry.code` made optional

While building Phase 2's v11 mappers against real API responses (not just
the swagger doc), found that PTV v11's actual data includes code-list
entries with no `code` at all — ontology terms are identified by `uri`
only (confirmed live: `GET /api/v11/Service/{id}`'s `ontologyTerms[].code`
is `null` in production data). Phase 1's `CodeListEntry.code` was typed as
required (`string`), which the v11 mapper couldn't honestly satisfy
without fabricating a value.

Fix applied to: src/ptv/domain.ts (`code: string` -> `code?: string`,
with a comment recording why).
Re-verified: `npm run typecheck` and `npm test` (27/27) both pass
unchanged; this is a pure widening of an existing field, not a shape
change, so nothing that already matched the old type stops matching.
Phase 1 re-locked — no other Phase 1 file touched.

---

## 2026-09-16 — Phase 2 (`PtvV11Adapter` implementation) closed ✅ 🔒

Owned files:
- src/ptv/v11/swagger.json (vendored spec), wire-types.ts (generated, gitignored from Prettier)
- src/ptv/v11/wireModel.ts, client.ts, pagination.ts, adapter.ts
- src/ptv/v11/mappers/{common,service,serviceChannel,organization,generalDescription,serviceCollection,connection,codeList}.ts
- src/ptv/v11/deleteFlags.ts, deleteFlags.test.ts
- src/ptv/v11/writeMapping.ts, writeMapping.test.ts
- src/ptv/v11/auth/{oauth,introspection}.ts, oauth.test.ts
- src/ptv/v11/adapter.integration.test.ts

Two independent, self-contained chunks of this phase were delegated to
background Haiku subagents in parallel with the rest of the work (per
explicit instruction): the delete-flag mapping table
(`src/ptv/v11/deleteFlags.ts` + tests, 44 tests) and the OAuth consent
flow module (`src/ptv/v11/auth/*` + tests, 30 tests). Both were reviewed
before integrating, not merged blindly:
- deleteFlags.ts: one unused import (`ServiceChannelType`) removed; a test
  used `as any` where the lint config requires an explicit type, fixed to
  `as unknown as EntityType`. Substance was correct and thorough — findings
  cross-checked against the same swagger.json this session already had
  vendored, not fabricated.
- auth/oauth.ts: one unused import (`randomBytes`, `randomUUID` was used
  instead) removed. Otherwise correct on inspection, and it correctly
  flagged (rather than asserted as fact) the two things this session
  couldn't verify: the real required OAuth scope, and the introspection/
  revocation endpoints' actual client-auth mechanism.

Sync point verified (Phase 2: "the Phase 1 contract test suite passes
against `PtvV11Adapter` for all read operations; a real human can click
the consent link, land back authenticated, and have `PtvAdapterRegistry`
resolve their stored connection for a write call"):
- [x] **Read side, fully verified live**: `runPtvAdapterContractTests`
      (13 assertions) run against a real `PtvV11Adapter` pointed at PTV's
      actual test environment (`api.palvelutietovaranto.trn.suomi.fi`),
      using real fixture ids fetched from that environment — not a mock,
      not the production host. All 13 pass.
- [x] Write path unit-tested (`writeMapping.test.ts`, 9 tests) — delete-
      flag vs. full-replace translation verified field by field against
      the real behaviors `deleteFlags.ts` found in the swagger schema.
- [ ] **Live write / full consent-flow, NOT verified end-to-end.** This
      needs a PTV OAuth client actually registered with
      `palveluhallinta.suomi.fi` — an external, organization-level
      prerequisite (someone with authority over the tenant's PTV
      relationship needs to register one) that isn't available in this
      session. The consent-flow code (`auth/oauth.ts`,
      `auth/introspection.ts`) is unit-tested against mocked HTTP and
      believed correct, but "a real human clicks the link and it works"
      has not been observed. **Flagging this as the one open item before
      Phase 6's launch gate can be called complete for real users.**

New verified facts this phase (not assumed from the OpenAPI doc alone —
found by calling the real API):
- v11's list endpoints (`GET /Service`, `/ServiceChannel`, etc.) return
  only `{id, name}` pairs with a server-fixed page size of 1000 (no query
  param to change it) — full entities come from a separate bulk
  `.../list?guids=a,b,c` endpoint. `ServiceCollection` has no such bulk
  endpoint, so its search fetches each id individually.
- `serviceClasses`/`ontologyTerms`/`targetGroups`/`lifeEvents` are written
  back as **URI strings**; `industrialClasses` as **code strings** — these
  differ per field, confirmed directly against the write schema, not
  inferred from the read shape.
- PTV v11 returns **HTTP 500**, not 404, for a lookup by the all-zero GUID
  (`00000000-...-000000000000`) — a genuinely random nonexistent id
  correctly gets 404. Caught by the live contract test run, not
  anticipated in advance; fixed the test fixture rather than the adapter
  (the adapter's 404-to-null handling is correct; the all-zero GUID is
  simply invalid input by PTV's own logic).
- v11's test-environment base URL, `https://api.palvelutietovaranto.trn.suomi.fi`,
  is undocumented in v11's own swagger.json (which lists only the
  production host) — confirmed live by direct request, following the same
  naming pattern PTV uses for v12.

Deviations:
- **`CodeListEntry.code` (Phase 1, locked) made optional.** Reopened
  Phase 1 briefly for this — see the dedicated log entry above. A genuine
  gap found from real data (v11 ontology terms have no `code`, only
  `uri`), not a design change.
- **Draft-visibility endpoints not implemented.** `Service/active/{id}`
  and `ServiceChannel/active/{id}` (the "restricted" endpoints that need
  auth and expose draft/modified content) are listed in the phase plan
  but not built this pass — `supportsDraftRead: false` in the shipped
  capabilities reflects this honestly rather than claiming a capability
  that isn't there. Not a blocker for Phase 3+: nothing downstream depends
  on draft visibility yet.
- **Hand-typed `wireModel.ts` instead of consuming the generated
  `wire-types.ts` directly.** The openapi-typescript output is a valid,
  complete 12,683-line type tree, vendored and kept for reference, but its
  deeply nested `paths`/`components` structure is unwieldy for mapper code
  that only touches a handful of fields per entity. The narrower
  hand-typed interfaces in `wireModel.ts` were verified field-by-field
  against real API responses (not guessed), so this trades one kind of
  rigor (generated-from-spec) for another (verified-against-live-data) —
  recorded here so it's a documented choice, not an oversight.
- **Live PTV test environment as the integration-test target**, not a
  mock. This proves the adapter for real but introduces an external
  dependency into CI: if PTV's test environment is unreachable or its
  fixture records ever change/disappear, `test:integration` (and thus CI)
  fails for reasons outside this repo's control. No mitigation applied
  yet — worth reconsidering if this becomes a recurring CI flake source.

---

## 2026-09-16 — Phase 1 reopened: `users` schema extended, `memberships` RLS policy widened

While starting Phase 3 Stream A (auth) and Stream B (tenant/membership
management), found two genuine gaps in Phase 1's locked output rather than
just needing new Phase-3-owned files:

1. **`users` had no columns for the auth features the phase plan itself
   assigns to Phase 3** (email verification, login lockout) — Phase 1
   deliberately scoped `password_hash` only, per its own log entry ("the
   real Argon2id login flow is Phase 3's concern"), but verification and
   lockout need dedicated columns, not just application logic. Added
   `email_verified_at`, `failed_login_attempts` (default 0), `locked_until`
   to `src/db/schema/user.ts`. Purely additive (new nullable columns / a
   defaulted counter) — no existing column changed shape, so nothing that
   already matched the old shape stops matching.
2. **`memberships`' RLS policy (Phase 1, `drizzle/0001_row_level_security.sql`)
   made "which tenants do I belong to" unanswerable under RLS.** The
   policy only matched `tenant_id = app.current_tenant_id`, but a user
   doesn't know which tenant_id to set as context until they've already
   read their own memberships — this blocks the exact multi-tenant
   membership example `docs/plan.md` itself gives (one user belonging to
   several tenants with different roles). Genuine defect, not a
   preference: the declared feature was unimplementable as the policy
   stood. Fixed via a new migration (`drizzle/0003_membership_self_visibility.sql`,
   preceded by `0002_phase3_auth_tables.sql` for the new tables/columns)
   that widens the policy to `tenant_id = current_tenant_id OR user_id =
   current_user_id`, keeping it fail-closed when neither is set and never
   exposing another user's row in a tenant the caller doesn't share.

Owned files touched (Phase 1 reopen):
- src/db/schema/user.ts (columns added)
- drizzle/0003_membership_self_visibility.sql (new migration; policy fix)
- src/db/rls.integration.test.ts (three new test cases)

New files, owned by Phase 3 from the start (not a reopen):
- src/db/schema/refreshToken.ts, emailVerificationToken.ts, passwordResetToken.ts
- drizzle/0002_phase3_auth_tables.sql
- src/db/schema/index.ts (new exports appended)

Re-verified Phase 1's sync point: dropped/recreated `ptv_mcp_dev`, ran
`scripts/bootstrap-roles.sql` then `npm run db:migrate` through all four
migrations with no manual intervention; `npm run test:integration` — now
20 tests (17 before + 3 new) — all passing, including the new
self-visibility, no-cross-user-leak, and still-works per-tenant-admin-view
cases. Phase 1 re-locked.

Deviation: the new auth-token tables (`refresh_tokens`,
`email_verification_tokens`, `password_reset_tokens`) are **not**
RLS-scoped, matching the existing `users`/`tenants` precedent documented
in `drizzle/0001_row_level_security.sql` — a refresh/verify/reset lookup
necessarily happens by token hash before the caller's identity is
otherwise established, so no `current_setting('app.current_user_id')`
context exists yet at query time. Access is controlled by query pattern
(always an exact hash match, never a bare listing) instead.

---

## 2026-09-16 — Phase 3, Stream A (Auth) closed ✅ 🔒

Owned files:
- src/security/envelopeEncryption.ts, envelopeEncryption.test.ts
- src/db/context.ts, context.integration.test.ts
- src/auth/password.ts, password.test.ts
- src/auth/tokens.ts
- src/auth/jwt.ts, jwt.test.ts
- src/auth/mailer.ts
- src/auth/authService.ts, authService.integration.test.ts
- src/auth/rbac.ts, rbac.integration.test.ts
- src/routes/auth.ts, auth.integration.test.ts

Also touched, as additive extensions of locked earlier-phase files (not
reopens — same reasoning as Phase 1 Stream A's CI-file extension): 
- src/config.ts: added `jwtSecret`, and switched `masterEncryptionKey`
  from an optional placeholder to `requireEnv` now that Stream A/B
  actually perform real cryptographic operations with it, not just carry
  it as a placeholder. `.env.example` and `.github/workflows/ci.yml`
  updated to match (CI's `MASTER_ENCRYPTION_KEY` placeholder also fixed
  from a non-base64/wrong-length string to a valid 32-byte key, since it's
  now actually decoded rather than just read as an opaque string).
- src/app.ts: `buildApp` now takes `{ config, db?, mailer? }` instead of a
  bare config object, and wires up `AuthService` + `authRoutes`. The `db`/
  `mailer` injection points exist specifically so route-level integration
  tests can run against a real Postgres connection with a fake mailer,
  without the app owning connection lifecycle in tests.
- src/server.ts, src/routes/health.test.ts: updated for `buildApp`'s new
  call shape.

`envelopeEncrypt`/`envelopeDecrypt` (AES-256-GCM envelope encryption, one
data key per secret wrapped by a master key) are built now, ahead of
Stream B integrating them into `TenantEnvironment`/`UserPtvConnection`
storage, since Stream A's own scope didn't need them but Stream B does —
built as a shared, standalone module rather than duplicated.

A dedicated `JWT_SECRET` was introduced rather than reusing
`MASTER_ENCRYPTION_KEY` for JWT signing — different purpose (session
authentication vs. wrapping stored PTV credentials) and different
rotation schedule; a leak of one shouldn't compromise the other.

Sync point verified (this stream's slice of Phase 3's goal — "resolve
tenant + role" via RBAC, "credentials decrypt" is Stream B/D's slice):
- [x] `npm run typecheck`, `lint`, `format`, `test`, and `build` all pass.
- [x] `npm run test:integration` — 48/48 passing, including:
  - `authService.integration.test.ts` (15 tests against real Postgres):
    register, duplicate-email rejection, email verification (incl.
    already-consumed-token rejection), login, wrong-password rejection,
    lockout after 5 failed attempts and recovery after the lockout window,
    refresh-token rotation, denylisting the whole chain on replay of an
    already-rotated token, logout revocation, password reset (incl.
    revoking all outstanding sessions), no email-enumeration on reset
    request, expired-refresh-token rejection.
  - `auth.integration.test.ts` (9 tests via `app.inject()`): the same
    flows exercised through real HTTP routes end to end, including a
    302→401 rejected-reuse-after-logout case.
  - `rbac.integration.test.ts` (4 tests): unauthenticated request
    rejected, a Reader rejected below a Publisher-only route, a user with
    no membership at all rejected, a Publisher let through with their
    role correctly resolved on `request.role`.
  - `context.integration.test.ts` (2 tests, from the Phase 3 foundation
    commit): `withContext` actually threads `set_config` through
    drizzle's transaction API against the real `ptv_mcp_app` role.

Deviations:
- **Email verification does not block login.** Registration issues a
  verification token/email and `/auth/verify-email` consumes it, but
  logging in doesn't require `email_verified_at` to be set. The phase
  plan calls for "sähköpostin vahvistus" as a feature to exist, not
  necessarily as a login gate, and gating login would need a product
  decision (e.g. a grace period) the plan doesn't specify. Tracked here
  as an explicit scope choice, easy to add as a `login()` precondition
  later if the product wants it.
- **No real email provider.** `LoggingMailer` (src/auth/mailer.ts) logs
  the verification/reset link instead of sending it — there's no
  SMTP/provider credential to configure yet. The `Mailer` interface is
  the seam a real provider plugs into later without touching
  `AuthService`.
- **Argon2id selected by literal value (`2`), not the crate's `Algorithm`
  enum import** — `@node-rs/argon2`'s `Algorithm` is an ambient `const
  enum`, which `verbatimModuleSyntax` (already on in `tsconfig.json`)
  can't import (TS2748). Documented inline in `password.ts` with the
  crate's own docs reference so it doesn't look like a magic number.
- **RBAC role check is per-request DB lookup, no caching** — matches
  `docs/phase-plan.md`'s risk register note that membership must always
  be re-checked at call time, never cached, since a user's PTV connection
  outlives their tenant membership.

---

## 2026-09-16 — Phase 3, Stream B (Tenant & credential management) closed ✅ 🔒

Owned files:
- src/tenants/tenantService.ts, tenantService.integration.test.ts
- src/credentials/userPtvConnectionService.ts, userPtvConnectionService.integration.test.ts
- src/credentials/tenantEnvironmentService.ts, tenantEnvironmentService.integration.test.ts
- src/credentials/ptvAdapterConfigService.ts, ptvAdapterConfigService.integration.test.ts
- src/routes/tenants.ts, tenants.integration.test.ts
- src/routes/ptvConnections.ts, ptvConnections.integration.test.ts

Also touched, additively:
- src/config.ts, .env.example: added `PTV_V11_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`
  (all optional, default `''`) for the connect-PTV routes below.
- src/app.ts: wires `TenantService`, `UserPtvConnectionService`, and the
  new route plugins into `buildApp`.

What got built, matching the phase plan's Stream B scope exactly:
- **Tenant/membership CRUD**: `TenantService` + `/tenants` routes — create
  a tenant (creator becomes its first Tenant Admin, atomically, in one
  transaction — see deviation below), list a user's own tenants across
  every tenant they belong to (this is what the Phase 1 membership-RLS
  reopen exists for), add/update/remove members by a Tenant Admin.
- **`UserPtvConnection` gets a full write path** (the phase plan's wording
  distinguishes this from `TenantEnvironment`, which doesn't yet):
  `UserPtvConnectionService` (envelope-encrypted access token storage) plus
  `/ptv-connections/*` routes implementing the actual per-user consent
  flow docs/ptv-v11-notes.md describes — authorize-url generation
  (wrapping Phase 2's `buildAuthorizationUrl`), the callback that parses
  the captured fragment (Phase 2's `parseCallbackFragment`), validates it
  via introspection (Phase 2's `introspectToken`) before ever storing it,
  and disconnect (attempts PTV revocation best-effort, then always revokes
  our own record regardless of whether PTV's call succeeded).
- **`TenantEnvironment` storage + encryption, tests only, no routes** —
  `TenantEnvironmentService`, exactly as scoped ("no UI or write path yet"
  in the phase plan, since nothing populates it until Phase 7's
  `PtvV12Adapter` exists to use it).
- **`PtvAdapterConfig` wired to the real DB table** — `PtvAdapterConfigService`,
  consumed by Stream D's registry next.

Sync point verified (this stream's slice — full registry resolution is
Stream D's):
- [x] `npm run typecheck`, `lint`, `format`, `test`, and `build` all pass.
- [x] `npm run test:integration` — 82/82 passing, adding 34 new tests
  across the six files above (service-level: create/list/add/update/
  remove for tenants, encrypt/decrypt/revoke/reconnect for both
  credential-scope tables, upsert/list for adapter config; route-level:
  full HTTP flows including RBAC enforcement — a Reader gets 403 adding a
  member, an unauthenticated request gets 401 — and the OAuth callback
  path with a stubbed `fetch` for introspection/revocation).

Deviations:
- **Bug found and fixed before this stream closed**: the first version of
  `TenantService.createTenant` inserted the tenant in one
  `db.transaction()`, then called `withContext(this.db, ...)` for the
  membership insert — `withContext` opens its *own* transaction, which
  (being a separate Postgres transaction/connection) can't see the
  tenant row the outer transaction hadn't committed yet, so every
  membership insert failed its foreign-key constraint. All 8
  `TenantService` tests caught this immediately. Fixed by running
  `set_config` directly on the same `tx` as the tenant insert instead of
  nesting a second transaction — documented here since it's exactly the
  kind of RLS/transaction-scoping mistake the phase plan's Phase 1
  deviation note warned about, just one level up the call stack.
- **No CSRF-binding for the OAuth `state` parameter.** `authorize-url`
  generates and returns a `state` value, but nothing persists it
  server-side to verify the callback's request actually corresponds to
  the authorize-url call that issued it — the callback endpoint requires
  the caller to already be authenticated with our own JWT, which bounds
  the blast radius (an attacker would need to hijack an authenticated
  session, not merely lure a visitor), but this is weaker than a fully
  server-verified state round-trip. No new token table was added for this
  in Stream B; worth revisiting in Phase 5 when a real web UI (with a
  place to hold client-side state, e.g. a short-lived cookie) exists.
- **Introspection/revocation calls use the real PTV endpoints with
  whatever `PTV_V11_OAUTH_CLIENT_ID/SECRET` are configured** — since no
  real client is registered yet (external prerequisite, same gap Phase 2
  flagged), these routes are fully built and tested against a mocked
  `fetch`, but a real callback against production PTV won't work until
  that registration exists. This is a continuation of Phase 2's open
  item, not a new one.

---

## 2026-09-16 — Phase 3, Stream C (Audit logging) closed ✅ 🔒

Owned files:
- src/audit/auditService.ts, auditService.integration.test.ts

Delegated to a background Haiku subagent (per explicit instruction — this
stream shares no files with Stream D, which was built directly), given
detailed instructions including the project's RLS/`withContext` pattern,
the transaction-nesting bug already found once this phase (see Stream B's
entry), and the sibling services to imitate for style. Reviewed in full
before accepting — implementation is correct, matches project
conventions (terse JSDoc, `withContext` used correctly with no nesting,
`and()`'s `undefined`-filtering used idiomatically for optional filters).

**Also fixed, correctly, two files outside its assigned scope**:
`src/db/context.integration.test.ts` and `src/db/rls.integration.test.ts`
each had a raw `audit_entries` insert missing the new NOT NULL
`correlation_id` column (added moments earlier in this same phase, before
the subagent was dispatched — see the schema-changes entry above) — both
inserts would otherwise fail. This was a real, necessary fix (this
session's own oversight, not the subagent's), correctly identified and
applied; accepted as-is rather than reverted.

`AuditService`: `record()` (generates `correlationId` if omitted,
append-only — no update/delete method exists on the class at all),
`listForTenant()` (optional `resourceType`/`correlationId` filters,
default limit 100, newest first), `listByCorrelationId()` (every entry
for one logical operation, chronological, no limit).

Sync point verified (this stream's slice):
- [x] `npm run typecheck`, `lint`, `format` all pass.
- [x] `npm run test:integration` — 9 new tests (insert/return-all-fields,
  correlationId generation vs. caller-supplied, chronological grouping by
  correlationId, cross-tenant RLS isolation, resourceType filtering,
  limit respected, default-limit-100, descending order) — all passing
  against real Postgres.

---

## 2026-09-16 — Phase 3, Stream D (Adapter registry) closed ✅ 🔒

Owned files:
- src/ptv/dbAdapterRegistry.ts, dbAdapterRegistry.integration.test.ts

Built directly (not delegated) as the architecturally load-bearing piece
of this phase, per this project's established practice.

`DbPtvAdapterRegistry implements PtvAdapterRegistry` (the Phase 1
interface, untouched): tenant/role authorization always runs first and
is never cached (re-checked on every `resolve()` call, per
docs/phase-plan.md's risk register); then the matching `PtvAdapterConfig`
row is picked for the tenant/environment/operation; then credentials are
resolved from `UserPtvConnection` or `TenantEnvironment` depending on the
config's declared `credentialScope`; then an `AdapterFactory` (keyed by
`api_version`, defaulting to `{ v11: ... }`) constructs the concrete
adapter. `adapterFactories` is constructor-injectable specifically so
tests can exercise the **tenant-scoped credential branch** with the Phase
1 `InMemoryPtvAdapter` under a fake `api_version` — there's no second
real adapter yet, but the resolution *logic* for that branch is fully
exercised now rather than deferred to Phase 7, per the phase plan's
explicit instruction to do so.

Also added `checkV11Liveness()` (the phase plan's "liveness/readiness
polling for the active adapter") — a real, unauthenticated call through
`PtvV11Adapter.searchServices` against PTV's live test environment,
reusing the exact same read path every real caller goes through rather
than a bespoke ping.

**Read vs. write credential strictness is asymmetric, deliberately**: a
missing/absent credential for a *write* always throws
`credential_missing_or_expired`; for a *read*, it's tolerated (the
adapter gets constructed with no token at all) because v11's ordinary
reads need no credential in the first place (docs/ptv-v11-notes.md) — the
registry doesn't punish a read for a connection nobody has set up yet.

Sync point verified — this is Phase 3's overall stated sync point, not
just Stream D's: **"log in, resolve tenant + role, the registry picks
`PtvV11Adapter`, credentials decrypt, a real PTV call succeeds, and an
audit entry is recorded naming the adapter used."**
- [x] `src/syncPoints/phase3.integration.test.ts` (new, cross-stream):
  registers and logs in a real user (Stream A) against real Postgres;
  creates a tenant and confirms `tenantService.listTenantsForUser`
  resolves the correct role (Stream B, exercising the Phase 1 RLS
  reopen); resolves a read via the registry with no connection stored,
  gets a genuinely unauthenticated `PtvV11Adapter`, and makes a real
  live call against PTV's test environment that succeeds (Stream D);
  stores a user connection then resolves a write, capturing the exact
  decrypted token via an injected factory to prove decryption is
  byte-exact (Stream B + D together); records an audit entry naming
  `apiVersion: 'v11'` and reads it back (Stream C). All against real
  Postgres and real PTV, no mocks.
- [x] `src/ptv/dbAdapterRegistry.integration.test.ts` — 10 tests: reader
  rejected for write (`not_authorized`, before any credential lookup
  runs at all — confirmed by there being no stored connection either),
  outsider with no membership rejected, no-config → `no_adapter_configured`,
  write unsupported by config → `operation_not_supported`, write with no
  stored connection → `credential_missing_or_expired`, real live read
  with no connection succeeds, exact-token-decryption assertion via
  injected factory, **both credential-scope branches** (user-scoped via
  real `PtvV11Adapter`, tenant-scoped via `InMemoryPtvAdapter` under a
  fake `api_version` with the same registry instance), tenant-scoped
  credential-missing case, `checkV11Liveness` against the real test
  environment.
- [x] Full pipeline: `typecheck`, `lint`, `format`, `test` (123),
  `test:integration` (102), `build` all pass.

New verified fact this phase (see docs/ptv-v11-notes.md's new section):
sending a malformed `Authorization: Bearer` token to an otherwise-
unauthenticated v11 GET endpoint gets **HTTP 500**, not 401 or a clean
200 ignoring the header — found while writing the sync-point test itself
(it originally tried to make a live call using a deliberately-fake stored
token), not anticipated in advance. Fixed by restructuring the test to
demonstrate "credentials decrypt" and "a real PTV call succeeds" as two
separately-verified facts (a fake token is never sent over the wire),
and documented as a second instance of the same "v11 500s on certain
malformed input" pattern Phase 2 found with the all-zero GUID.

**Phase 3 as a whole is now closed.** All four streams done; the
cross-stream sync point passes against real Postgres and real PTV.

---

## 2026-09-16 — Phase 4 (MCP tool layer) closed ✅ 🔒

Owned files:
- src/mcp/toolContext.ts
- src/mcp/searchTools.ts, searchTools.test.ts
- src/mcp/proposeChanges.ts, proposeChanges.test.ts
- src/mcp/validateChanges.ts, validateChanges.test.ts
- src/mcp/applyOrExport.ts, applyOrExport.test.ts
- src/mcp/authorization.ts
- src/mcp/mcpServer.ts
- src/mcp/httpTransport.ts, httpTransport.integration.test.ts
- src/mcp/testing/fakeAuditService.ts
- src/validation/changeValidator.ts, changeValidator.test.ts
- src/syncPoints/phase4.integration.test.ts

Also touched, additively:
- src/auth/rbac.ts (Phase 3 Stream A, locked): extracted
  `resolveMembershipRole(db, tenantId, userId)` out of `createRequireRole`'s
  inline query, so the MCP tool layer (no Fastify request/reply) can reuse
  the exact same membership lookup instead of a second implementation.
  `createRequireRole`'s own behavior is unchanged — this is a pure
  extraction, not a reopen of its logic.
- src/app.ts: wires `PtvAdapterConfigService`, `TenantEnvironmentService`,
  `DbPtvAdapterRegistry`, `AuditService`, `V11ChangeValidator`, and the new
  `/mcp` route into `buildApp`.
- package.json: added `@modelcontextprotocol/sdk` (v1.30.0) and `zod`
  (v4.6.5) — the actual MCP protocol implementation and its schema library,
  not previously a dependency.

Added `@modelcontextprotocol/sdk` and built a **real** MCP server, not a
simulated one — `McpServer` from the SDK, 14 tools registered with zod
input schemas, mounted at `POST /mcp` via `StreamableHTTPServerTransport`
in **stateless mode** (no `sessionIdGenerator`, matching the SDK's own
`examples/server/simpleStatelessStreamableHttp` reference pattern exactly:
a fresh `McpServer` + transport constructed per HTTP request). Verified
against the SDK's real `Client` + `StreamableHTTPClientTransport` over a
real listening HTTP socket (`src/mcp/httpTransport.integration.test.ts`,
`src/syncPoints/phase4.integration.test.ts`) — not just unit-testing the
tool functions in isolation.

Stream A (search tools): `searchServices`, `getService`, `searchChannels`,
`getChannel`, `getOrganisation`, `getOrganisationHierarchy`,
`searchServiceCollections`, `searchGeneralDescriptions`,
`searchConnections` (`getConnectionsFor` under the phase plan's
`ptv_search_connections` name), `listCodes` — each a thin pass-through to
a registry-resolved adapter's own method, since the Phase 1 `PtvAdapter`
interface already has a 1:1 method for every tool the phase plan lists.

Stream B (propose-changes / diff engine): `proposeChanges` merges a
`Partial<Service>` onto the current service using the same "field
presence, not truthiness" semantics as the v11 write model
(`writeMapping.ts`), and computes a field-level diff — localized fields
(`names`/`summaries`/`descriptions`) expand to one diff entry per
*changed language* (`'names.fi'`), other fields diff as a whole-value
replacement. **The `ProposeChangesResult` shape is the frozen contract**
the phase plan calls for — `{serviceId, current, proposed, diff,
correlationId}` — Phase 5's diff UI builds against this exact shape.

Stream C (validation engine, delegated to a background Haiku subagent,
reviewed before accepting): `ChangeValidator` interface +
`V11ChangeValidator`, 8 rules (required `names`/`organizationId`/
`serviceType`/`languages`, `ontologyTerms` ≤ 10, `serviceClasses` ≤ 4,
and — the one rule not explicit in docs/plan.md's list but found by
reading `writeMapping.ts` — every `serviceClasses`/`ontologyTerms`/
`targetGroups`/`lifeEvents` entry needs a `uri` and every
`industrialClasses` entry needs a `code`, or `writeMapping.ts` silently
drops it on write). Accumulates every violation in one pass rather than
stopping at the first.

Stream D (apply/export): `exportForManualPublish` renders a proposed
service per language and records `ReadyForManualPublish` (MVP-0's
no-API-write fallback, per docs/plan.md); `applyChanges` re-validates
internally (never trusts a possibly-stale prior validation from another
tool call), then resolves a write-capable adapter via the registry
(Publisher role + `supports_write` + a valid credential all enforced
there, per Phase 3 Stream D) and records `Success` or `Failed` either
way — a write that throws is still audited, not silently dropped.

**Bug found and fixed before this phase closed**: `PtvAdapterRegistry`
only gates *PTV adapter/credential* access (Reader for read operations,
Publisher for write) — it has no notion of this app's own business-action
permissions. The first version of `proposeChanges`/`exportForManualPublish`
only called the registry with `operation: 'read'`, which meant a bare
Reader could propose and export changes — docs/plan.md's role model
explicitly reserves that for Editor and above ("Reader ei saa ehdottaa
muutoksia"). Fixed by adding `src/mcp/authorization.ts`'s
`requireTenantRole`, called before anything else in `proposeChanges`
(and therefore in `exportForManualPublish`/`applyChanges`, which both
call it internally) — checked via an injectable `MembershipRoleResolver`
function rather than a raw DB handle, so the existing fast/no-Postgres
unit tests for these modules didn't have to become integration tests
just to exercise a role check. `ptv_apply_changes`'s stricter Publisher
requirement continues to come from the registry's own `operation: 'write'`
resolution — Editor doesn't satisfy that, so no separate check was needed
there.

Sync point verified (docs/phase-plan.md's Phase 4 goal — "end-to-end
script: search a real service via v11, propose a rewrite, validate it,
then either export it or apply it directly — with every step in the
audit log"):
- [x] `npm run typecheck`, `lint`, `format`, `test` (190), `test:integration`
  (107), `build` all pass.
- [x] `src/syncPoints/phase4.integration.test.ts`: a real MCP `Client`
  over `StreamableHTTPClientTransport`, against a real listening Fastify
  server, real Postgres, and PTV's live test environment — register+login,
  create a tenant with Editor role, `ptv_get_service` on a known real
  fixture id, `ptv_propose_changes`, `ptv_validate_changes`,
  `ptv_export_for_manual_publish`, all sharing one `correlationId`, then
  `AuditService.listByCorrelationId` confirms all four audit entries
  (`ProposeServiceChange` ×2 — validate and export each internally
  re-propose against the current live state rather than trusting a
  earlier call's snapshot — `ValidateServiceChange`, `ExportForManualPublish`)
  landed under that one correlation id.
- [x] `src/mcp/httpTransport.integration.test.ts` (4 tests): tool listing
  over the real protocol, 401 with no bearer token before any MCP
  handshake, a real live `ptv_search_services` call, and a
  `not_authorized` tool error (not a transport exception) for a tenant
  the caller doesn't belong to.

Deviations:
- **Terminal step is `ptv_export_for_manual_publish`, not
  `ptv_apply_changes`**, in the sync-point script — the same external gap
  Phase 2/3 already documented: a real write needs a real per-user PTV
  OAuth connection, which needs a PTV client actually registered with
  palveluhallinta.suomi.fi. `ptv_apply_changes` itself is fully built and
  tested (unit tests covering validation-blocks-write, write-failure
  audit, registry-error propagation; `dbAdapterRegistry.integration.test.ts`
  covering the real write-capable-adapter resolution) — only the very
  last "does PTV actually accept this write" step is untestable without
  that external registration.
- **`applyChanges` re-validates unconditionally**, even if the caller
  already called `ptv_validate_changes` separately first — this produces
  a second `ValidateServiceChange` audit entry per apply, which is a
  correct record of what actually happened (validation really did run
  twice), not a bug, but worth flagging as an accepted minor audit-log
  duplication rather than a deduplicated "was this already validated"
  check.
- **A malformed-Bearer-token 500 risk does not apply here** (unlike
  Phase 3's sync-point deviation) — every MCP tool call in this phase
  either sends no PTV credential at all (Reader-level reads) or a real
  stored one, never a fabricated test string, so this phase's tests
  don't reproduce that v11 quirk.
- **`exactOptionalPropertyTypes` friction with `@modelcontextprotocol/sdk`'s
  own type declarations** (`sessionIdGenerator`, `onclose`, `sessionId` all
  declared as bare-optional in a way this repo's strict tsconfig doesn't
  accept when assigned across the library boundary) — worked around with
  narrow, documented `as unknown as Transport` casts at the exact call
  sites (`server.connect(...)`, `client.connect(...)`), and by omitting
  `sessionIdGenerator` entirely rather than setting it to `undefined`
  (which itself already means stateless mode per the SDK's own docs, so
  no behavior is lost). Same category of pre-existing friction as Phase 3's
  `@node-rs/argon2` `Algorithm` const-enum workaround — a tsconfig/library
  interop issue, not a bug in either side.
- **No MCP resources or prompts** — only tools, per the phase plan's
  explicit scope (Phase 4 is "MCP tool layer"). Resources/prompts aren't
  mentioned anywhere in docs/plan.md's MCP tool list either.

## 2026-09-16 — Phase 5 (Web UI) closed ✅ 🔒

Owned files:
- web/ — new package (Vite + React + TypeScript SPA), not specified by
  docs/phase-plan.md beyond "Web UI"; the stack itself is a Phase 5
  deviation, documented below.
  - web/src/api/client.ts, api/types.ts
  - web/src/auth/AuthContext.tsx
  - web/src/tenants/TenantContext.tsx
  - web/src/components/Layout.tsx
  - web/src/App.tsx, main.tsx, index.css
  - web/src/pages/LoginPage.tsx, RegisterPage.tsx
  - web/src/pages/TenantsPage.tsx (Stream A)
  - web/src/pages/MembersPage.tsx (Stream A, built by a background Sonnet
    subagent, reviewed before accepting — no changes needed)
  - web/src/pages/PtvConnectionsPage.tsx, PtvCallbackPage.tsx (Stream B,
    built by a background Sonnet subagent, reviewed before accepting — no
    changes needed)
  - web/src/pages/AuditLogPage.tsx, DiffView.tsx (Stream C)
- src/routes/auditLog.ts, auditLog.integration.test.ts (Stream C's backend
  half — `GET /tenants/:tenantId/audit-entries`, tenant_admin only,
  filterable by `resourceType`/`correlationId`/`limit`)

Also touched, additively:
- src/tenants/tenantService.ts, tenantService.integration.test.ts: a real
  gap found while verifying this phase's sync point (below) — membership
  CRUD (`addMember`/`updateMemberRole`/`removeMember`) recorded nothing to
  the audit log at all. Fixed by injecting `AuditService` into
  `TenantService` and recording `AddMember`/`UpdateMemberRole`/
  `RemoveMember` (resourceType `Membership`, resourceId the target user,
  actor as `userId`) after each successful mutation. `createTenant` itself
  is unchanged — the sync point only calls for member-management actions.
- src/routes/tenants.ts: passes the authenticated caller
  (`request.userId!`) through as the new `actingUserId` parameter on the
  three `TenantService` methods above.
- src/routes/ptvConnections.ts, ptvConnections.integration.test.ts: same
  gap, personal-connection side. `user_ptv_connections` is deliberately
  user-scoped, not tenant-scoped (Phase 3 Stream B: one credential reused
  across every tenant the user belongs to), but `audit_entries.tenant_id`
  is `NOT NULL` and RLS-gated on it — a personal connection event has no
  single natural tenant to record against. Resolved by recording the
  event once per tenant the connecting user currently belongs to
  (`ConnectPtvAccount`/`DisconnectPtvAccount`, resourceType
  `PtvConnection`), via a new `recordConnectionEvent` helper that fans out
  through `tenantService.listTenantsForUser`. A user connecting before
  joining any tenant produces zero audit entries for that connection —
  accepted as a documented edge case, not fixed further (see Deviations).
- src/app.ts: constructs `AuditService` before `TenantService` (ordering
  fix — `TenantService` now depends on it) and wires `tenantService` +
  `auditService` into `ptvConnectionRoutes`'s options.
- src/syncPoints/phase3.integration.test.ts: same `TenantService`
  constructor reorder, no behavioral change to the test itself.
- eslint.config.js: **real pre-existing bug, unrelated to this phase's
  own code**, found while running the full pipeline — the backend's
  `ignores: ['dist/**', 'node_modules/**']` only matches those directories
  at the repo root (flat-config ignore globs aren't implicitly
  `**/`-prefixed), so `npx eslint .` was sweeping in `web/dist`'s built,
  minified bundle once `web/` existed, producing over a thousand
  `no-undef`/`no-unused-expressions` errors on code that was never meant
  to be linted by the backend's ESLint (the frontend has its own
  `oxlint`). Fixed by changing the ignores to `['**/dist/**',
  '**/node_modules/**', 'web/**']`.
- web/vite.config.ts: the dev-proxy comment originally asserted production
  static-file serving already happens via a `src/routes/webUi.ts` that
  doesn't exist — corrected to say that's deferred to Phase 6 (see
  Deviations).

Stream A (auth & tenant/user management UI): login/register forms against
the real `/auth/*` routes; `TenantsPage` (list + create, `POST /tenants`);
`MembersPage` (list/add/inline role change with a confirm step/remove, all
tenant-admin-gated, `403`/`404` surfaced as inline errors not crashes).

Stream B (credential management UI): `PtvConnectionsPage` — per-environment
connect/disconnect against v11's implicit-grant OAuth flow;
`PtvCallbackPage` captures `window.location.hash`, guards against
React StrictMode's double-invocation of effects with a `useRef`, and POSTs
the fragment to `/ptv-connections/v11/callback` for introspection-validated
storage. Tenant-admin `TenantEnvironment` (API key) UI remains deferred to
Phase 7, per docs/phase-plan.md's own note on Stream B's scope.

Stream C (audit log viewer): `AuditLogPage` — filterable by resource type
and correlation id, one row per entry, an expandable `DiffView` table for
any `ProposeServiceChange` entry (rendering the frozen `ServiceDiffEntry[]`
contract from Phase 4 Stream B unchanged). Backend-side, `auditLogRoutes`
exposes `AuditService.listForTenant` at `GET
/tenants/:tenantId/audit-entries`, gated the same way `MembersPage` is
(tenant_admin only).

Sync point verified (docs/phase-plan.md's Phase 5 goal — "a tenant admin
can create a user and set their role; a user can connect their own PTV
account; both show up correctly in the audit log"):
- [x] `npm run typecheck`, `lint`, `test` (190), `test:integration` (113),
  `build` all pass on the backend; `tsc -b && vite build` and `oxlint`
  (0 errors, pre-existing style warnings only — see Deviations) pass on
  `web/`.
- [x] Real browser verification (Playwright against the actual dev
  servers, real Postgres, no mocks): registered two users via the API,
  logged in as one through the real login form, created a tenant through
  the real form, added the second user as a member through the real
  `MembersPage` form, changed their role to `publisher` through the same
  page's inline `<select>` (accepting the real `window.confirm` dialog),
  then navigated to `AuditLogPage` and confirmed both `AddMember` and
  `UpdateMemberRole` entries appear, `resourceType: Membership`, the
  correct `resourceId`, `result: Success`.
- [x] `src/tenants/tenantService.integration.test.ts`: a new test asserts
  the same `AddMember`/`UpdateMemberRole` audit entries directly against
  `AuditService.listForTenant`, attributed to the acting admin.
- [x] `src/routes/ptvConnections.integration.test.ts`: a new test creates
  a tenant for the connecting user, drives a full mocked-introspection
  `POST /ptv-connections/v11/callback`, then confirms a `ConnectPtvAccount`
  audit entry appears in that tenant's audit log via the real
  `GET /tenants/:tenantId/audit-entries` route.
- [x] The Members page's data flow was double-checked after an initial
  Playwright run appeared to show 0 rows right after navigation — a
  second run with an explicit wait and a full DOM dump confirmed the
  table renders correctly (one row for the tenant creator); the first
  result was a read-before-fetch-resolved timing artifact in the test
  script, not a defect in `MembersPage.tsx`.

Deviations:
- **Frontend stack (Vite + React + TypeScript, `web/` as a separate
  package) is an unspecified-by-docs but necessary decision** — the phase
  plan says "Web UI" without naming a stack. Chosen for a proxied dev
  server against the existing Fastify backend and a plain `tsc -b && vite
  build` production build; `oxlint` for frontend lint, matching the
  backend's existing ESLint/ESLint-adjacent-but-separate convention rather
  than sharing one linter config across two very different runtime
  targets (Node vs. browser globals).
- **Tokens stored in `localStorage`, not an httpOnly cookie** — simplest
  option for an internal admin tool's MVP; documented, accepted XSS
  trade-off (see `web/src/api/client.ts`'s own comment). Revisit if this
  UI ever needs to defend against a more adversarial environment than
  "trusted tenant staff."
- **Personal PTV-connection audit events fan out to every tenant the
  connecting user belongs to, not one canonical entry** — the only
  alternative that keeps `audit_entries.tenant_id` `NOT NULL` (and RLS
  gated on it) intact without a schema change. Accepted because a
  personal v11 credential is, by Phase 3 Stream B's own design, reused
  across every tenant the user is a Publisher for — every one of those
  tenants' admins has a legitimate reason to see when it was connected or
  disconnected. A user with zero tenant memberships at connect time gets
  zero audit entries for that connection; this is a real, accepted gap
  (not silently swallowed — `recordConnectionEvent` simply has nothing to
  fan out to), worth revisiting only if a future phase needs a
  user-scoped audit view that doesn't go through any tenant.
- **Production static-file serving is deferred to Phase 6, not built
  here** — `web/vite.config.ts`'s dev proxy is dev-only; Fastify serving
  `web/dist` in production belongs with Phase 6's "deployable, reviewed,
  documented" goal (Docker/Compose, CI/CD), not this phase's UI-feature
  work. The comment that used to claim this already existed
  (`src/routes/webUi.ts`) was corrected rather than left misleading.
- **The v11 OAuth connect flow itself is not end-to-end tested in the
  browser** — same external gap Phase 2/3/4 already documented: it needs
  a real client registered with palveluhallinta.suomi.fi. The callback
  page's logic (fragment capture, introspection call, error paths) is
  covered by `ptvConnections.integration.test.ts` with a mocked
  introspection response instead.

---

## 2026-09-16 — Phase 6 closed ✅ 🔒

Owned files:
- `src/syncPoints/phase6.integration.test.ts`
- `src/routes/webUi.ts`
- `src/app.ts`
- `Dockerfile`
- `docker-compose.production.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- `docs/deployment-guide.md`
- `docs/adapter-onboarding-runbook.md`
- `README.md`
- `PLAN.md`

Sync point verified (docs/phase-plan.md Phase 6 checklist):
- [x] Added end-to-end role-flow integration coverage for the MCP
      propose/validate/export/apply chain (`src/syncPoints/phase6.integration.test.ts`):
      Reader blocked at propose, Editor can propose/validate/export but not apply,
      Publisher and Tenant Admin can apply.
- [x] Added multi-tenant isolation coverage in the same sync-point test:
      cross-tenant read/write denied, and one user-scoped v11 connection is reused
      across two allowed tenants for the same publisher.
- [x] Production static serving implemented: Fastify serves SPA assets and
      deep-link fallback from `web/dist` in production (`src/routes/webUi.ts`),
      wired from app bootstrap (`src/app.ts`).
- [x] Production image path finalized (`Dockerfile`) and production compose
      file added (`docker-compose.production.yml`) with external Postgres only.
- [x] CI/CD deploy step added (`.github/workflows/deploy.yml`) to build and
      publish production images to GHCR on main / manual dispatch.
- [x] Deployment and adapter-onboarding runbook documentation added and linked
      from README.

Validation run:
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run build`
- [x] `npm --prefix web ci && npm --prefix web run lint && npm --prefix web run build`
- [x] `docker compose -f docker-compose.production.yml config` (with placeholder required env vars)
- [x] `docker build .` (backend + web build path validated in container)
- [ ] `npm run test:integration` in this sandbox (blocked: no local Postgres
      server and no DNS access to `api.palvelutietovaranto.trn.suomi.fi` for
      the live v11 adapter integration suite)

---

## 2026-09-16 — Phase 6 CI-red incident fixed; Phase 7 (MCP resources) and Phase 8 (proposal queue) retroactively documented and closed

This entry covers work landed on `main` (PR #7, branch
`copilot/implement-phase-6`) while the primary session was rate-limited,
plus the fixes and documentation this session made once it resumed and
audited that work (via a background research agent, then verified
directly against a real Postgres instance).

**What actually shipped in PR #7, beyond its own name**: the branch and
PR title only say "Phase 6", but its commit history
(`5e0d2e0 Implement Phase 7 resources and Phase 8 proposal queue
foundations` onward) also built two more features in full: MCP resources
wrapping the get-by-id tools, and a persisted propose→review→resolve
queue (Reader queues, Editor+ resolves). Neither `PLAN.md` nor
`docs/phase-plan.md` was updated to give this work its own phase
numbers or document it as built — the previous "Phase 6 closed" entry
above is accurate for Phase 6 itself, but the repo had zero documentation
trace of the Phase 7/8 work until this entry. Independently, this session
had already drafted (pre-rate-limit) a phase-plan amendment inserting
exactly these two phases in this position — see `docs/phase-plan.md` and
`PLAN.md`'s current Phase 7/8 sections, written to describe what was
**actually built**, confirmed file-by-file, not the original speculative
design (a few details differ from the original draft — e.g. the resource
URI's `code-lists` segment name, the `queued_diff` column name, the
`ReviewProposal`/`ResolveProposal` audit action names).

**Bug found and fixed**: `src/syncPoints/phase6.integration.test.ts`'s
tenant-isolation test asserted a wrong error shape. A user with *no*
membership at all in a tenant calling `ptv_apply_changes` fails the
Editor-level business check inside `proposeChanges()`
(`src/mcp/authorization.ts`'s `NotAuthorizedError`, message "Not
authorized: this action requires at least 'editor' role...") *before*
ever reaching `PtvAdapterRegistry.resolve({operation: 'write'})` — only a
*member* whose role is too low reaches the registry and gets its
`reason: 'not_authorized'` (a different string: `not_authorized` with an
underscore, vs. "Not authorized" with a space — the assertion checked for
the former in a case where the latter is what's actually thrown).
Verified by running the identical test against a real Postgres at the
original "Phase 6 closed" commit (`c5d6f64`), before any Phase 7/8
changes — this was a Phase 6 bug, not something the later work
introduced. Fixed the assertion to match the actual (correct) behavior
rather than changing the behavior itself.

**Also fixed**: `src/routes/webUi.ts` failed `npm run format` (prettier)
— a 3-line whitespace-only fix. `src/mcp/proposeChanges.ts`'s doc comment
still claimed "a bare Reader can search/read but not propose", which
stopped being true for the `ptv_propose_changes` **tool** once Phase 8
retargeted it at `queueProposal` (Reader+); corrected the comment to
describe what `proposeChanges()` actually is now — an internal re-diff
helper used only when resolving an already-queued proposal.

**Real process gap, not just a code bug — CI was red on both the PR and
the merge itself**: GitHub Actions run `35125426224` (the PR) and
`35134215650` (the push to `main` from the merge) both have
`conclusion: failure`, failing at the very first step, `npm run format`
— which meant `lint`/`typecheck`/`test`/`test:integration`/`build` were
all **skipped**, not passed. The above `phase6.integration.test.ts` bug
was therefore never actually exercised by CI before this merge — the
previous "Phase 6 closed" entry's checked-off validation-run items were
run locally/in a sandbox without Postgres, not confirmed by CI. This PR
was merged with CI red. Recorded here as a factual account, not to
relitigate the merge decision.

**Verified after these fixes** (real Postgres, full pipeline, this
session):
- [x] `npm run typecheck`, `npm run format`, `npx eslint .`
- [x] `npm test` — 193 unit tests passing
- [x] `npm run test:integration` — **119/119 integration tests passing**
      (was 118/119 before the assertion fix above), including
      `src/syncPoints/phase6.integration.test.ts`,
      `src/syncPoints/phase8.integration.test.ts` (both tests),
      `src/routes/proposals.integration.test.ts`, and the resource-read
      test in `src/mcp/httpTransport.integration.test.ts`
- [x] `npm run build`
- [x] `cd web && npm run build && npm run lint` (oxlint — only
      pre-existing warning patterns, e.g. `set-state-in-effect`, already
      present in `AuditLogPage.tsx`/`MembersPage.tsx`/
      `PtvConnectionsPage.tsx` before this work; `ProposalQueuePage.tsx`
      inherits the same pattern, not a new one)

**Known, deliberately-unfixed gap** (documented in `docs/phase-plan.md`'s
Phase 7 write-up, not silently dropped): the new MCP resource read
callbacks in `src/mcp/mcpServer.ts` don't wrap their body in the tools'
`try/catch → errorResult` convention. Investigated directly against the
`@modelcontextprotocol/sdk` source (`ReadResourceRequestSchema`'s
handler): a resource read has no `isError`-style result field the way
`CallToolResult` does, and the SDK's own "not found"/"disabled" cases use
the same mechanism this code does (throw, let it become a JSON-RPC
error) — tools and resources have genuinely different error-reporting
conventions by MCP protocol design, so this is not the same defect class
as the (correctly-caught) Phase 4 authorization gap. Left as-is because
"fixing" it into a tool-style result would violate `ReadResourceResult`'s
actual schema. The real gap is narrower: no test yet confirms what an
unauthorized or not-found resource read actually returns to a client.

See `docs/phase-plan.md`'s Phase 7 and Phase 8 sections for full
as-built detail (schema, role model, URI shapes, audit actions) — written
to describe the merged code exactly, confirmed file-by-file rather than
assumed from the original design draft.

---

## 2026-09-20 — Repo-wide documentation audit and correctness review

Session scope: create `CLAUDE.md`, bring `PLAN.md`/`docs/*.md` up to date
with actual code state, and review the codebase for correctness, altitude,
and reusability. No new feature work was requested or done — everything
below is either a documentation correction or a bug fix in existing code.

### Documentation found stale, now corrected

`PLAN.md` and `docs/phase-plan.md` still marked **Phase 9
(`PtvV12Adapter`) as not-started** (`⏸`, every checklist item `[ ]`).
Actual code state: `PtvV12Adapter` (`src/ptv/v12/adapter.ts`) is fully
wired into `DbPtvAdapterRegistry` alongside `PtvV11Adapter` and reachable
in production today; the tenant-admin v12 API-key UI
(`web/src/pages/PtvConnectionsPage.tsx`, `src/routes/ptvV12.ts`) is live,
not deferred. Both docs' Phase 9 sections were rewritten to describe what
is actually built, with two real gaps called out (not just marked "done"):
`searchServiceCollections`/`searchGeneralDescriptions`/`listCodes` are
unimplemented stubs that throw for any v12-reading connection, and the
implemented search methods (`searchServices`/`searchChannels`/
`searchOrganisations`) fetch PTV's **entire** catalogue per content type
and filter/paginate **in memory** rather than using server-side query
params — `getConnectionsFor` doesn't even paginate at all, silently
truncating large result sets. Neither is a hypothetical concern for
Finland's national service catalogue; both are recorded in the new
`docs/ptv-v12-notes.md` (mirroring `docs/ptv-v11-notes.md`, but written
from the adapter implementation itself since no v12 OpenAPI spec is
vendored in this repo, and this session had no live network path to fetch
one from inside the review — a follow-up worth doing before trusting the
wire-shape fallback chains documented there).

Also entirely undocumented until now: **independent read/write PTV API
version selection per OAuth connection** (`drizzle/0011_oauth_independent
_api_versions.sql` through `src/mcp/oauthService.ts`/`toolContext.ts`/
`searchTools.ts`/`applyOrExport.ts`) — a connection can read via one API
version and write via another. This shipped across ~11 commits with no
phase-plan entry or design note. Documented now in `docs/phase-plan.md`'s
Phase 9 section and `CLAUDE.md`.

`README.md` updated to link the new `docs/ptv-v12-notes.md` and note both
adapters are live side by side.

### Correctness bugs found and fixed

**The branch's `HEAD` did not pass `npm run typecheck`, `npm run lint`, or
`npm run format`** before this session (confirmed via `git stash` against
the original commit) — the OAuth read/write API-version split (`apiVersion`
made a required field on `PtvAdapterResolutionRequest`) broke several
call sites that were never updated, and separate pre-existing issues had
accumulated (see below). All fixed; full pipeline (`format`, `lint`,
`typecheck`, `npm test` — 199 tests, `npm run test:integration` — 123
tests against a real local Postgres, `npm run build`, `web`'s build+lint)
is green as of this entry.

Fixed, by area:

- **`src/ptv/dbAdapterRegistry.ts`'s `resolve()` unconditionally threw
  when `tenantId` was undefined**, even though `PtvAdapterRegistry`'s own
  doc comments (and an existing test,
  `dbAdapterRegistry.integration.test.ts`'s "resolves public v11 OUT
  without a tenant or membership") describe unauthenticated public v11
  reads without a tenant as an intentional, documented capability. The
  branch for it was simply never implemented. Added it back: an
  undefined `tenantId` is only accepted for `operation: 'read'` with
  `apiVersion: 'v11'`, constructing the v11 factory directly — safe
  because every other read/write path still goes through the normal
  membership check, this is strictly additive.
- **Five MCP resource read handlers in `src/mcp/mcpServer.ts` silently
  ignored the resource URI's own `{tenantId}`/`{environment}` segments**,
  using `toolContext(extra)` (token-derived tenant/environment, same as
  tools) instead. Not a privilege escalation (`PtvAdapterRegistry.resolve()`
  still authorizes whatever tenant is actually used), but it meant the
  documented "tenant/environment embedded in the URI" resource design
  (Phase 7) was never actually implemented — a resource URI naming a
  different tenant had no effect. Added `resourceToolContext(extra,
  uriTenantId, uriEnvironment)` and switched all five handlers to it. See
  `docs/phase-plan.md`'s Phase 7 section for the full writeup.
- **`ptvAdapterConfigService.ensureV11ReadDefaults` per-tenant failures
  could abort the whole v11-connect request and skip the audit entry**,
  even though the OAuth token itself was already durably stored
  (`src/routes/ptvConnections.ts`): `Promise.all` over independent
  per-tenant transactions meant one tenant's failure rejected before the
  audit call ran, while other tenants' updates stayed committed. Changed
  to `Promise.allSettled` with per-failure logging; the connection's
  success is recorded regardless. Also stopped fetching
  `listTenantsForUser` twice per request (once for the read-defaults
  loop, once inside `recordConnectionEvent`) — now fetched once and
  passed through.
- **`AuthService.logout()` didn't check that the refresh token being
  revoked belonged to the authenticated caller** (`src/routes/auth.ts`) —
  any authenticated user who obtained another user's raw refresh-token
  string could revoke that user's session. Added an `and(eq(tokenHash,
  ...), eq(userId, callerId))` check; added a test proving a non-owner's
  logout call no longer revokes someone else's token.
- **`web/src/api/client.ts`'s `apiFetch` had no de-duplication for
  concurrent 401-triggered refreshes.** The backend rotates refresh
  tokens and treats reuse of an already-rotated one as theft, revoking
  *every* session for the user
  (`src/auth/authService.ts`'s reuse-detection). Two components firing
  `apiFetch` near-simultaneously with an expired access token could both
  race to refresh with the same stale token, the second collision
  triggering an unintended full logout. Fixed with a shared in-flight
  promise.
- **Login timing side-channel**: `AuthService.login()` returned
  immediately for an unregistered email but ran a real Argon2id verify
  for a registered email with a wrong password, making "is this email
  registered" distinguishable by response time despite an identical error
  message. Added a fixed dummy-hash verify on the not-found path so both
  cases pay the same Argon2id cost.
- **Registration TOCTOU**: two concurrent registrations for the same
  email could both pass the existence pre-check, and the DB's unique
  constraint on `users.email` then surfaced as a raw 500 instead of the
  intended `EmailAlreadyRegisteredError`/409. Now caught and mapped
  (Postgres error code `23505`).
- **`npm run mcp:token` (`src/mcp/token.ts`) was fully broken**: it still
  called `oauthService.issueAccessToken(...)` with its old 3-argument
  signature after the OAuth split made it a 7-argument function
  (`userId, clientId, scope, tenantId, environment, readApiVersion,
  writeApiVersion`), and separately constructed its `OAuthService` with a
  `resource` (`config.mcpPublicUrl + '/mcp'`) that doesn't match
  `src/app.ts`'s own construction (`config.mcpPublicUrl`, no suffix) — a
  mismatched audience claim means a token minted by the old code would
  have failed verification against the real running server even before
  the argument-count bug. Fixed both: the script now prompts for a
  tenant/environment/API versions and its `OAuthService` matches `app.ts`
  exactly.
- **A cluster of integration tests minted the wrong kind of token for MCP
  calls** — `AuthService.login()`'s plain web-session JWT (no
  `iss`/`aud`/tenant claims) was being sent as the `/mcp` bearer token in
  `src/syncPoints/phase4.integration.test.ts`, `phase6.integration.test.ts`
  (both tests), `phase8.integration.test.ts` (both tests),
  `src/mcp/httpTransport.integration.test.ts` (multiple tests), and
  `src/routes/proposals.integration.test.ts`. `OAuthService.verifyAccessToken()`
  requires a matching issuer/audience the login JWT never carries, so
  every one of these calls silently failed authentication
  (`"No authenticated user for this MCP session"`) and every downstream
  assertion about tool behavior was untested — this was true on the
  original, unmodified `HEAD`, confirmed via `git stash`, not something
  introduced this session. All six files switched to minting real MCP
  OAuth tokens via `OAuthService.issueAccessToken(...)` (matching
  `app.ts`'s issuer/resource). This also exposed that MCP **tools** have
  no per-call tenant argument at all (tenant comes solely from the
  token) — `phase6.integration.test.ts`'s "reuses one user-scoped
  connection across multiple allowed tenants" test used to pass one
  token across three different `tenantId` tool arguments, which were
  always silently ignored; rewritten to mint one token per tenant instead
  (still proving the underlying point: the *same* v11 connection,
  keyed by `user_id` not `tenant_id`, is reused across all three).
  `httpTransport.integration.test.ts`'s "rejects a request with no bearer
  token... expects 401" test was itself wrong against the code's own
  documented design (`httpTransport.ts`'s explicit comment: auth is
  deliberately deferred to the tool layer so an unauthenticated
  `tools/call` can return a structured OAuth-challenge tool error rather
  than a blanket HTTP 401, which ChatGPT's connector flow needs) —
  rewritten to assert the actual, intended behavior.
- Minor: removed dead code (`src/ptv/v12/adapter.ts`'s unused
  `normalizePage`, duplicating `extractItems`/`extractTotalCount`/
  `paginate`; two unused TTL constants in `src/mcp/oauthService.ts`; an
  unused import in `src/mcp/httpTransport.ts`), a duplicate `state?:
  string` field in `OAuthService`'s `AuthorizationRequest` interface, an
  `any`-typed connection mapper in `src/ptv/v12/adapter.ts` tightened to
  `unknown`, and a pointless `organisations.items.length > 1` branch in
  `src/mcp/searchTools.ts`'s `findOrganisationAndChildren` that did the
  exact same thing as the `=== 1` case below it (both just used
  `items[0]`).

### Known gaps documented, not fixed this session

- `PtvV12Adapter`'s full-catalogue-fetch search pattern and its three
  unimplemented methods (see `docs/ptv-v12-notes.md`) — real scalability
  and functional gaps, left as findings rather than attempting a fix
  without a vendored v12 OpenAPI spec to verify against.
- The Phase 1 contract test suite has still never been run against either
  real adapter (`PtvV11Adapter` or `PtvV12Adapter`) — only against
  `InMemoryPtvAdapter`. This is the single gap that would have caught the
  v12 unimplemented-methods issue immediately; recorded as the top
  priority in `docs/ptv-v12-notes.md`'s "open items" list.

## 2026-09-24 — v12 read side verified live and fixed

Every MCP read tool was run against the live v12 API through the deployed
server (redeployed after each merge via the Farcmd "Deploy: PTV-MCP"
command) and checked against `docs/ptv-api-documentation.json`. Details
are in `docs/ptv-v12-notes.md` ("Live verification and fixes").

- #22: read `totalItems` so catalogue scans fetch every page (Riihimäen
  seurakunta was not findable). The same PR restored a green `main`:
  `npm run build` (and so `docker build`) failed on
  `exactOptionalPropertyTypes` errors, four unit tests had stale
  expectations, and eleven files failed `prettier --check`.
- #23: v12 field names (`parentOrganizationContentId`,
  `TelephoneService`, `PermitOrOtherObligation`,
  `generalDescriptionContentId`, `serviceLanguages`), server-side
  connection search, collection members, code-list paging, parallel
  page fetching.
- #24: `serviceChannelIds` from connections; connection
  `publishedAt`/description.
- #25–#27: classification names from reference data with a process-wide
  cache (30 days, 1 day for unknown codes); empty translations dropped;
  entries completed to v11's `{code, uri, names}` so v12-read services
  pass `V11ChangeValidator`.
- This PR: `ptv_search_ontology_terms` (v12 only; v11 throws
  `OntologySearchUnsupportedError`), plus this log entry and the v12
  notes update.

Deviation worth knowing: the deployed server runs `tsx watch` (dev mode),
not the Docker image, so the code-name cache lives only as long as that
process.


## 2026-09-24 — Persistent code-name cache, KOKO URI rule, deploy script

- The v12 code-name cache is now backed by Postgres
  (`ptv_code_name_cache`, migration 0016), so names survive restarts and
  redeploys. The table is global reference data: no `tenant_id`, no RLS,
  explicit `GRANT` to `ptv_mcp_app` (see 0015 for why not rely on default
  privileges). The in-memory `CodeNameCache` stays as the first level;
  missing keys are primed from Postgres, new entries written through.
  Store errors are swallowed and fall back to PTV lookups.
- `V11ChangeValidator` rule 9: `ontologyTerms[].uri` must be
  `http://www.yso.fi/onto/koko/pNNN`. YSO URIs get a hint that KOKO
  numbers differ, so they must be looked up (`ptv_search_ontology_terms`),
  not rewritten.
- `scripts/deploy.sh`: pull (fast-forward only), `npm ci` when
  dependencies change, `db:migrate`, optional `PTV_MCP_RESTART_CMD`,
  health check. The previous Farcmd deploy didn't run migrations.

## 2026-09-24 — v11 writes: organisation API user (test environment first)

- DVV's IN-integration docs show v11 writes authenticate with an
  **organisation API user** (username + password → token), not the per-user
  implicit grant assumed in `docs/ptv-v11-notes.md`. The notes now carry an
  update section at the top of "Auth model".
- New `src/ptv/v11/auth/apiLogin.ts`: login per environment, JWT-`exp`-based
  process-wide token cache, and one shared in-flight login. `PtvV11Client`
  takes a `writeTokenProvider` used for POST/PUT only, and retries once
  with a fresh login on 401. `v11Factory` accepts tenant-scoped credentials
  `{username, password, apiUserOrganisation?}`.
- New tenant-admin routes `GET/PUT /tenants/:tenantId/ptv/v11/api-user` and
  `POST .../api-user/:environment/test`, plus a web UI section. Saving sets the
  v11 adapter config to `credentialScope: 'tenant'`, `authMode: 'api_login'`,
  with write enabled.
- `docs/ptv-test-environment.md`: DVV's test organisations and endpoints.
  The public test passwords are linked (DVV's XLSX), not copied.
- Known gap: credential changes on these routes (and the v12 API-key routes)
  aren't audited yet.

## 2026-09-24 — v12 write auth: API key + token (DVV email)

DVV told us by email that v12 writes identify the *integration* with the API key and the
*user/organisation* with a token. Recorded in `docs/ptv-v12-notes.md`
("v12 write auth") with the design consequences. No code changes; v12
write goes to beta in October 2026.

## 2026-09-24 — v11 writes verified live (test environment, organisation 15)

Plan: `docs/v11-write-plan.md`. Findings: `docs/ptv-v11-notes.md`, "Live
write findings". Every step was tested through the PTV-MCP connector
(propose → `approve_and_apply` → read back), fixed, merged and redeployed
with Farcmd.

- #39: the service PUT needs `publishingStatus`, the classifications
  (without a general description) and whole description lists, so the body
  is built on the current record. `serviceChannels: null` crashed
  `ptv_get_service`. Adds the plan.
- #40: PTV's 400 field errors and our validation errors are readable.
- #41: draft reads through `Service/active` / `ServiceChannel/active`
  with the API-user token; PUTs build on the latest version.
- #42: classifications diffed by URI; validator rules 10 (classifications
  required without a general description) and 11 (not only main service
  classes).
- #43, #45: `Modified` status. Reading it no longer throws, but writing it
  locks the service against API updates. PTV-MCP never writes it, refuses
  early, and validator rule 12 flags it. *Testipalvelu 7* is left
  `Modified` and needs publishing or discarding in PTV's UI.
- #44, #46: connections are written through the Connection endpoint. Its
  PUT replaces the list (it dropped two connections live, restored
  straight away), so the full list is sent with extra info kept.
- #47: industrial classes are written as stat.fi URIs (plain codes → 500);
  validator rule 13 (KR2 + subgroup).
- #48: service creation (`ptv_propose_new_service`, proposal kind
  `service_create`, migration 0017).
- #49, #51: general description unlink sends `type`, and inherited
  classifications aren't adopted.
- #50: channel updates (`ptv_propose_channel_changes`, all five types).
- #52: credential changes on the v11 API-user and v12 API-key routes are
  audited, without secrets.

Deviation: creating channels is out of scope for now (type-specific data
the domain model lacks). Creation and channel updates still need live
verification: the connector's tool list predates them, so it has to be
reconnected.


## 2026-09-24 — v11 channel updates and service creation verified live

Through the reconnected PTV-MCP connector (test environment, organisation
15):

- Channel updates (`ptv_propose_channel_changes` → `approve_and_apply`)
  work for EChannel, Phone, ServiceLocation and WebPage. Each `fi`
  description got " (PTV-MCP testi)" and was restored. Compared with a
  public-API snapshot, only `modified` differs afterwards; Summaries,
  other languages, hours and addresses survived. PrintableForm is still
  unverified (organisation 15 has none).
- Service creation failed: PTV refused the hard-coded
  `areaType: "Nationwide"` for a `LimitedType` organisation. #54 copies the
  organisation's area into the POST, and the `ptv_propose_new_service`
  description now says localized fields are keyed by language (an array
  shape only failed validation on `names`).
- After #54 was deployed, create → publish → archive passed live with
  the test service *PTV-MCP testipalvelu (poistetaan)*
  (`4678d0e0-ca3f-476c-8dfa-1630ebcfe378`, now archived). The proposal
  recorded the new id, and the draft read back through `Service/active`.
- The archive worked in PTV, but the tool call failed with "Service not
  found": the proposal response re-diffs against the live service, which
  404s once archived. #56 returns the stored proposal instead
  (`current`/`proposed` null), for `ptv_get_proposal` too.
- The first deploy attempt failed on the server's GitHub SSH key
  (`Permission denied (publickey)`); fixed on the server, outside the repo.


## 2026-09-24 — Roles step 4: four-eyes

- `tenants.require_four_eyes` (migration 0020, default true, so every
  existing tenant gets it on). `resolveProposal` refuses
  `approve_and_export`/`approve_and_apply` when the resolver created the
  proposal; reject stays allowed so a proposer can withdraw.
- The direct `ptv_export_for_manual_publish`/`ptv_apply_changes` tools are
  refused while four-eyes is on: they would let one person both write and
  approve. Phase 4/6 sync tests create their tenant with it off; a new
  Phase 6 test covers the refusal.
- `GET/PUT /tenants/:id/settings` (Viewer reads, Tenant Admin writes,
  audited as `UpdateTenantSettings`); checkbox on the members page.
- Live testing with one account needs four-eyes switched off for that
  tenant first, or a second account to resolve.

## 2026-09-24 — Roles step 5: required reviewers

- `proposal_reviewers` (migration 0021, RLS + grant, `review_decision`
  enum). `resolveProposal` refuses `approve_*` until every reviewer has
  `approved` (`ReviewsPendingError`, REST 409); reject stays allowed.
- MCP: `ptv_request_review` names reviewers by email or user id (an agent
  does not know UUIDs; without reviewers it lists the possible ones),
  `ptv_sign_off_proposal` (approved / changes_requested + comment),
  `ptv_list_proposals` `waitingForMe`. Only the proposer or an Approver+
  may add reviewers; reviewers must be Contributor+ and not the proposer.
- Web: reviewers panel with Hyväksyn / Pyydän muutoksia buttons and a
  "waiting for my review" filter. The SPA reads its own user id from the
  access token's `sub` to decide which buttons to show; the server still
  checks everything.

## 2026-09-24 — Roles step 6: readable diff and preview

- `diffService` copies names of classifications the service already has
  onto proposed entries given by uri or code only. New entries keep their
  bare code: v11 has no standalone classification code lists
  (`listCodes` refuses them), so there is nothing to look them up from.
- Web: Finnish field labels (`Nimi (suomi)`), classification changes as
  +/− lists, and a per-language "Preview after approval" from the
  proposal's `proposed` (updates, new services and channels).
- This completes docs/roles-and-review-plan.md steps 1–6.

## 2026-09-24 — Guides, skills and AI-compliance rules served over MCP

The DVV content guidelines (kehittajille.suomi.fi, "Sisällön tuottaminen
Palvelutietovarantoon" and every page under it, plus "Palvelutietovarannon
käyttöönotto" and "Työskentelyn organisointi") were crawled and condensed
into guides. So were the EU AI Act Art. 50 rules (not postponed by the
Digital Omnibus) and VM's generative AI guidance.

- `guides/`: `getting-started-with-ptv.md`, `content-quality.md` (writing
  rules plus a review checklist with `Q-*` check ids),
  `api-credentials.md` and `ai-compliance.md`.
- `skills/`: `ptv-mcp-admin/SKILL.md` and `ptv-mcp-workflow/SKILL.md`, in
  Agent Skills format so they can also be installed as client skills.
- `src/mcp/guides.ts` serves them in four ways:
  - the read-only `ptv_get_guide` tool
  - static `ptv-guide://{topic}` resources
  - three prompts (`ptv_review_content`, `ptv_content_workflow`,
    `ptv_admin_setup`)
  - server `instructions` sent at initialize. They carry the
    non-negotiables: no approve or apply without the user seeing the diff
    and explicitly asking, no invented facts, no secrets, no personal
    names.
- The Dockerfile copies `guides/` and `skills/` into the runtime image,
  because they are read at runtime rather than compiled.

Known gaps:

- `api-credentials.md` has no v12 key instructions yet. DVV is expected
  to publish them around late October 2026. v11 is deliberately left
  undocumented.
- The quality checklist is guidance for the AI and the approver. The
  `Q-*` checks aren't implemented in `ChangeValidator`.
- Approval in chat still depends on the AI following the instructions.
  The server can't tell whether a human or the model issued
  `ptv_resolve_proposal`.

## 2026-09-24 — Automated quality checks, review campaigns, "waiting for you"

Plan: `docs/review-campaigns-plan.md`.

- `src/quality/contentChecks.ts` makes the checkable `Q-*` rules of
  `guides/content-quality.md` deterministic (errors vs heuristic
  warnings). Its results appear:
  - in `quality` on every propose result and on `ptv_get_proposal`
    (shown on the web proposal page)
  - from the new `ptv_check_quality` tool
  - on each review item

  The guide's section 9 now marks every check *auto* or *manual*, and the
  workflow skill tells the AI to report the automated results as they are
  and to hand-check only the manual items. The Finnish passive and
  participial heuristics exclude common case-form false positives
  (asioitaan, itsellään, tilanteessasi).
- Review campaigns: migration `0022_review_campaigns` adds the
  `review_campaigns` and `review_items` tables (RLS, grant), plus
  `proposals.review_item_id`.
  - Code: `src/reviews/reviewService.ts` (persistence) and
    `src/reviews/reviewCampaigns.ts` (roles and rules).
  - Nine `ptv_review_*` MCP tools and REST under
    `/tenants/:id/review-campaigns` and `/review-items`.
  - `reviewItemId` on the three propose tools.
  - Web: a "Content review" page.
- `ptv_my_tasks` / `GET /tenants/:id/my-tasks`: the pull-style inbox, also
  shown as "Waiting for you" on the Content review page. MCP notifications
  were considered and not used: the transport is stateless and clients
  don't show notifications to users.
- The skills now use the new role names.
- Tests:
  - `src/quality/contentChecks.test.ts`
  - `src/routes/reviews.integration.test.ts`: the full campaign through
    REST and MCP, and the inbox
  - RLS coverage for both new tables

Known gaps:

- Checks cover only what the domain model maps: no instructions, channel
  contact fields or opening hours yet.
- The v11 adapter has no children query, so sub-organisations come from
  the cached organisation catalogue.
- Campaign start reads everything synchronously, which can be slow for
  very large organisations.
- The in-memory test adapter ignores `organizationId` filters.

## 2026-09-25 — Full service channels, and Publisher drafts sent to reviewers

- **Channel fields.** The domain `ServiceChannel` now carries:
  - summaries and `isVisibleForAll`
  - urls, web pages, phone numbers (Phone/Sms/Fax), emails, support
    contacts
  - service hours, visiting and postal addresses, delivery addresses
  - form files and identifiers
  - e-service authentication and signatures, and accessibility

  All optional, so v12 and the fakes are unaffected. v11 reads and writes
  them (`src/ptv/v11/channelFields.ts`). PUTs send only the changed lists,
  and emptied lists go as `deleteAll*`. `CHANNEL_TYPE_FIELDS` limits each
  type to its own fields.
- **New channels.**
  - `ptv_propose_new_channel` queues a `channel_create` proposal
    (migration 0023). approve_and_apply POSTs `/ServiceChannel/{type}`
    through the new `PtvAdapter.createChannel` and records the id;
    approve_and_export leaves it for manual entry.
  - `serviceIds` connects the new channel on create.
  - `CreateChannel` is audited.
- **Validation and checks.**
  - `src/validation/channelRules.ts` adds PTV's hard rules: phone
    format, URLs (and `tunnistautuminen.suomi.fi`), service hours,
    addresses, the required fields per type, and summary length.
  - `checkChannel` adds channel summaries and guideline warnings: prices
    of extra-charge numbers, several numbers without additional info, a
    service location without a street address, ended exceptional hours,
    untitled parallel schedules, and e-service accessibility.
  - The guide's Q-CONTACT-1 and Q-HOURS-1 are now marked mostly/partly
    auto.
- **Publisher drafts in review campaigns.**
  - `ptv_review_attach_proposal` (and REST `…/review-items/:id/attach`,
    plus an Attach field in the web UI) attaches a pending proposal to an
    item.
  - Proposing with `reviewItemId` does the same.
  - A finished item reopens, and the item's reviewer becomes a required
    reviewer of the draft.
  - A service change that edits connections can answer a channel's item.
- **Web.** The proposal preview shows channel fields (`ChannelDetails`),
  and there is a "New channel" proposal kind.
- **Tests.**
  - Unit: v11 channel read/write mapping, the channel validation rules,
    the channel checks.
  - Integration: a Publisher's draft channel goes to the reviewer, waits
    for their sign-off, and a second Publisher applies it (four-eyes); an
    existing proposal is attached over REST; a wrong-type field is
    refused.

Known gaps:

- The channel mapping follows the v11 schema and is **not verified
  live**. `docs/ptv-v11-notes.md` lists what to check.
- Not yet written:
  - channel areas (they inherit from the services)
  - e-service attachments
  - accessibility statement links
  - a service location's alternative name and entrances
- A service's instructions (toimintaohjeet) are still not in the domain
  model.

## 2026-09-24 — Tool titles and annotations

- Every MCP tool now has a Finnish `title` and behaviour hints from one
  table, `TOOL_METADATA` (`src/mcp/toolAnnotations.ts`). Registering a tool
  without an entry throws.
- Hints:
  - read-only: search, get, list and check tools, plus `ptv_my_tasks` and
    `ptv_validate_changes`;
  - `destructiveHint: true`: only `ptv_resolve_proposal` and
    `ptv_apply_changes`, the tools that can write to PTV;
  - `destructiveHint: false`: propose, comment, sign-off, export and
    review-campaign tools, which change only the MCP's own queue;
  - `openWorldHint: true`: tools that call PTV.
- Clients group tools by `readOnlyHint` and can ask for confirmation
  before destructive tools.

## 2026-09-24 — Live test of guides, quality checks, review campaigns and channels

Tested through the deployed MCP in PTV's test environment, as a Tenant Admin.

Worked as intended:
- the guides, as the `ptv_get_guide` tool and as `ptv-guide://` resources;
- `ptv_my_tasks` (empty, then with review items, a four-eyes proposal and
  campaign progress);
- `ptv_check_quality` on services and channels. It found opening hours in
  a description, a summary repeating the name, passive voice, long
  paragraphs, unconnected channels and several numbers without
  additional info;
- the v11 channel read mapping for all five types: addresses (visiting
  and postal), phone numbers, web pages, URLs, support emails, weekly and
  exceptional hours, accessibility and authentication;
- the review campaign cycle. The tools covered were start, list, get,
  assign (the error lists possible reviewers), my items, get item,
  complete, reopen, attach and close. The complete guards held: an item
  can't be confirmed with a pending linked proposal, and "changes
  proposed" is refused without one;
- channel proposals with `reviewItemId`, on structured fields (phone
  numbers, weekly and exceptional hours) and for a new channel. None was
  approved or applied.

Fixed after the test:
- **Campaigns with sub-organisations failed** ("firstPage.itemList is not
  iterable"). v11 returns `itemList: null` for an organisation without
  services or channels. The pagination helpers now treat it as empty.
- Q-HOURS-1 missed a past single-day exceptional hour (it has only
  `validFrom`). It now also warns about exceptional hours without a date
  or a title.
- Q-CONTACT-1 now warns about implausibly short numbers. The test data
  had a number "1", which PTV accepts.
- A new-channel proposal without `serviceIds` now gets Q-STRUCT-5.
- The ai-compliance guide now lists `ptv_propose_new_channel`.

Still to verify live: approving and applying channel field changes and a
channel create. Four-eyes needs a second member, or an explicit
decision to apply.

## 2026-09-24 — Manual publishing sheet, Q-STRUCT-5 while creating, hour ranges

- **Manual publishing.** `approve_and_export` used to leave only a
  per-language text preview (for service updates), and nothing tracked
  whether the change reached PTV.
  - Every approved proposal now has a `manualPublish` sheet: all changed
    fields, structured ones included, with PTV's Finnish labels, in the
    edit form's order and formats, plus the steps.
  - `ptv_confirm_manual_publish` and REST `confirm-published` close the
    proposal as `applied` after checking PTV. An update must re-diff
    empty; a new item is looked up by `ptvId`, its organisation and names
    are checked, and the id is recorded.
  - The web UI's Proposal queue shows the sheet with copy buttons and a
    Mark as published button.
- **Semantic diff.** `diffService` now ignores key order, and compares
  service hours in canonical form, because PTV returns weekly hours one
  day per entry. Before this, data read back from PTV could never equal a
  proposal.
- **Weekday ranges.** A weekly hour's `dayFrom`–`dayTo` (the guide's own
  example) went to v11 as is. PTV could read it as one long span, as it
  does for OverMidnight hours. It is now written one day per entry. The
  live test proposal for Testimonitoimitalo had exactly this shape.
- **Q-STRUCT-5** is a warning, with the next step, on new-service and
  new-channel proposals. They are created one at a time and linked after.
  It stays an error on published content.

## 2026-09-24 — Live test of writes and manual publishing

Four-eyes was switched off in the test tenant for this test.

- **Manual publishing.** The exported Testimonitoimitalo proposal
  (`ed200e44`) shows its `manualPublish` sheet. The weekly hours compare
  equal ("ma–pe 9.00–20.00, la–su 9.00–22.00"), so the sheet lists only
  the phone info and the new Christmas closure. It is left `approved` for
  a person to try the manual flow in PTV and confirm.
- **`approve_and_apply`, channel update** (`8ed80c58`, a WebPage summary):
  applied. It re-diffs empty right after the write.
- **`approve_and_apply`, channel create** (`7f1c6398`, a Phone channel):
  created `f937ac35-3779-4412-b6da-8d80b721d20a` as a Draft. Read back,
  every field matches, and the Mon–Fri range was stored as five day
  entries. It is a test channel ("Älä julkaise") and can be archived.
- **Rejected proposals page crashed** with "names[language]?.trim is not
  a function". An early test proposal (`27c8ff62`, service_create) had
  been stored with `names` in some other shape than `{ language: text }`,
  and the quality checks assumed text.
  - The checks now treat non-text as missing (Q-LANG-2).
  - The web preview renders only text.
  - Every propose path now refuses names, summaries and descriptions that
    are not `{ language: text }`, so such a proposal can't be stored again.

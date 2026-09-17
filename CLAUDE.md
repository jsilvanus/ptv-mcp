# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-tenant MCP server bridging Suomi.fi's Palvelutietovaranto (PTV) API
to AI agents. Node.js 22+, ESM/TypeScript throughout (`"type": "module"`,
`moduleResolution: NodeNext` — relative imports need a `.js` extension even
in `.ts` source), Fastify backend, Drizzle ORM over PostgreSQL 16, a Vite
+ React + TypeScript SPA in `web/`, and a real `@modelcontextprotocol/sdk`
MCP server exposing PTV operations as tools and resources.

Read `docs/plan.md` (architecture rationale, partly in Finnish),
`docs/phase-plan.md` (build sequence, current phase status, dependency
map, risk register), `docs/ptv-v11-notes.md` (PTV v11 API findings — auth
model, write-schema quirks), `PLAN.md` (live checklist) and
`EXECUTION_LOG.md` (append-only audit trail: owned files per phase, sync
point verification, deviations) before making changes — these are the
authoritative source of what's built, what's locked, and why. This
project follows a phase-based execution discipline: a completed phase's
files are locked (🔒 in `PLAN.md`) and not touched by later phases except
to fix a genuine, documented bug.

## Commands

```bash
npm run dev                # API with hot reload (tsx watch)
npm test                   # unit tests, no DB required (vitest, excludes *.integration.test.ts)
npm run test:integration   # DB-backed + RLS + live-PTV-test-env tests (vitest, matches "integration")
npx vitest run <path>      # a single test file
npx vitest run <path> -t "<test name>"   # a single test case
npm run lint                # eslint .
npm run format               # prettier --check . (use format:write to fix)
npm run typecheck            # tsc --noEmit
npm run build                # tsc (backend only); build:all also builds web/
npm run db:generate          # drizzle-kit generate, after schema changes
npm run db:migrate           # tsx src/db/migrate.ts
npm run db:seed              # local dev fixtures
```

Frontend (`web/`) has its own `package.json`: `npm run build` (`tsc -b && vite build`) and `npm run lint` (oxlint, a separate linter from the backend's ESLint).

Local setup: copy `.env.example` to `.env` (needs `DATABASE_URL`,
`MASTER_ENCRYPTION_KEY`, `JWT_SECRET` at minimum — `loadConfig()` in
`src/config.ts` fails fast listing whichever is missing). Env vars are
**not** auto-loaded from `.env` by any script — export them into the shell
first (`set -a && source .env && set +a`) before running anything that
reads config. A fresh Postgres cluster needs
`scripts/bootstrap-roles.sql` run once by a superuser before the first
`db:migrate` (creates the least-privilege, RLS-bound `ptv_mcp_app` role
the app actually connects as) — `docker-compose.yml` runs this
automatically via `docker-entrypoint-initdb.d`; a bare local Postgres
needs it run by hand (`sudo -u postgres psql -d ptv_mcp_dev -f
scripts/bootstrap-roles.sql`, after creating the `ptv_mcp` role/DB
`docker-compose.yml` otherwise provisions).

Production Postgres/MinIO are **external and separately managed** —
`docker-compose.yml`'s bundled Postgres is dev/staging only;
`docker-compose.production.yml` never bundles a database container.

## Architecture

### Ports and adapters: `PtvAdapter`

The core design bet is a version-agnostic adapter interface
(`src/ptv/adapter.ts`) so the rest of the system never touches a
PTV-API-version-specific shape. Every adapter implements the same
`PtvAdapter` interface over a shared domain model (`src/ptv/domain.ts`:
`Service`, `ServiceChannel`, `Organization`, `GeneralDescription`,
`ServiceCollection`, `Connection`, `CodeListEntry`) and declares its own
`PtvAdapterCapabilities` (`credentialScope: 'tenant' | 'user'`,
`supportsRead`/`supportsWrite`/`supportsDraftRead`).

`PtvV11Adapter` (`src/ptv/v11/`) is the first, complete implementation:
vendored `swagger.json`, generated `wire-types.ts` (via
`openapi-typescript`, never hand-edited) plus a hand-typed, narrow
`wireModel.ts` covering only the fields `mappers/*.ts` actually read
(verified against real API responses, not assumed from the spec), and a
per-content-type mapper in `mappers/`. v11's credential is **user-scoped**
(`UserPtvConnection`) — a per-user OAuth2 implicit-grant token, since PTV's
own OIDC discovery document has no `token_endpoint` at all (no refresh is
possible by design, not by implicit-grant limitation — see
`docs/ptv-v11-notes.md`). `PtvV12Adapter` (`src/ptv/v12/`, in progress) is
the second adapter: tenant-scoped `x-api-key` credential
(`TenantEnvironment`), read-only until PTV ships v12 write endpoints
(tracked as an external gate in `docs/phase-plan.md`, not something this
codebase controls).

`PtvAdapterRegistry` (`src/ptv/registry.ts` interface,
`src/ptv/dbAdapterRegistry.ts` implementation) is the **only** place that
resolves `(tenantId, environment, operation, actingUserId)` to a concrete,
already-credentialed adapter instance. It always checks tenant/role
authorization *before* resolving credentials (never replaces the check
with a credential lookup), re-checks on every call (never caches — a
user's PTV connection outlives their tenant membership), and picks
`UserPtvConnectionService` or `TenantEnvironmentService` for credentials
based on the resolved `PtvAdapterConfig` row's declared
`credentialScope`. Adding a new PTV API version means adding a factory
here and an adapter implementation — nothing else in the system should
need to change, which is the actual point of this pattern (and Phase 9's
`PtvV12Adapter` work is the real test of whether that held).

### Multi-tenancy and RLS

Every tenant-scoped table (`memberships`, `audit_entries`, `proposals`,
`tenant_environments`, ...) has Postgres Row-Level Security enabled and
forced, policy-gated on `tenant_id`. The app never connects as a
superuser/table-owner role — always as the least-privilege role RLS
policies actually apply to (`scripts/bootstrap-roles.sql`). Every
DB-touching call goes through `withContext(db, { tenantId, userId? },
callback)` (`src/db/context.ts`), which sets the Postgres session
variables RLS policies read — do not query tenant-scoped tables outside
`withContext`. `UserPtvConnection` (v11's per-user credential) is the one
exception to tenant-scoping: it's keyed by `(user_id, api_version,
environment)`, deliberately reusable across every tenant a user is a
Publisher for, because the credential is personal to that person on PTV's
own side, not organizational.

### Auth and RBAC

JWT-based (`src/auth/jwt.ts`), Argon2id password hashing, refresh-token
rotation with a denylist. Four ranked roles per tenant membership
(`src/auth/rbac.ts`): `reader < editor < publisher < tenant_admin`.
`createAuthenticate(jwtSecret)` verifies the bearer token and sets
`request.userId`; `createRequireRole(db, minRole)` resolves the acting
user's role for `request.params.tenantId` and rejects below `minRole` —
every tenant-scoped route composes these two as `preHandler`s. The same
role-check logic (`resolveMembershipRole`) is reused by the MCP tool
layer's authorization (`src/mcp/authorization.ts`), which has no Fastify
request/reply to hang a `preHandler` off of.

### MCP layer

`src/mcp/mcpServer.ts` builds the tool/resource surface over injected
dependencies; `src/mcp/httpTransport.ts` wires it to Fastify as a
stateless Streamable HTTP transport (a fresh MCP server per request —
construction is cheap, just closures over already-resolved
services/registry). `toolContext()` (in `mcpServer.ts`) builds a
`ToolContext` (`tenantId`, `environment`, `actingUserId`) from call
arguments plus the JWT-verified session on every call — there's no
persistent per-connection session to infer it from.

Tools wrap their body in `try { ... } catch { return errorResult(...) }`,
returning a structured `CallToolResult` with `isError: true` on failure.
**Resources do not** — the MCP SDK's `ReadResourceRequestSchema` handler
has no `isError`-equivalent result shape, so an uncaught throw (e.g.
`PtvAdapterResolutionError`) becomes a JSON-RPC-level error instead
(`McpError`, code -32603) with none of the tool path's machine-readable
`not_authorized`-style reason string — a confirmed, deliberate protocol
difference, not a bug to "fix" by adding try/catch (see
`src/mcp/httpTransport.integration.test.ts`'s resource-read tests for the
actual verified shape of both paths). A not-found get-by-id (tool or
resource) is not an error at all — the adapter returns `null`, and both
paths succeed with a `null`/`"null"` payload.

The propose → validate → export/apply flow: `ptv_propose_changes`
(`src/mcp/proposalQueue.ts`'s `queueProposal`, Reader+) persists a
`pending` row in `proposals` rather than returning a diff inline;
`ptv_list_proposals`/`ptv_get_proposal`/`ptv_resolve_proposal`
(Editor+) review and resolve it. Resolving **always re-diffs against
current state** (`prepareProposal()`/`diffService()` in
`src/mcp/proposeChanges.ts`) — the `queued_diff` column is audit/display
history only, never trusted as current. `approve_and_export` only needs
Editor; `approve_and_apply` additionally asks
`PtvAdapterRegistry.resolve({ operation: 'write', ... })`, so an Editor
without Publisher rights gets a structured `not_authorized` error and the
proposal stays `pending` (not `failed` — that status is reserved for an
actual write failure, not an authorization rejection).

### Validation

`src/validation/changeValidator.ts` defines a `ChangeValidator` interface
keyed by `apiVersion`, operating on the **domain model** (a fully-merged
proposed `Service`, not a wire-format request) — this is separate from
any wire-level JSON Schema validation. `src/ptv/v12/writeSchemaValidators.ts`
is a different, lower layer: Ajv validators compiled directly from the
vendored `openapi.json`'s `Post*/Put*Request` schemas, for validating a
wire-shaped request body before it would ever be sent to PTV — not yet
wired into the domain-level `ChangeValidator` registration.

### Frontend

`web/` is a separate npm package (Vite + React + TS SPA), proxied to the
Fastify backend in dev, served as static assets by Fastify
(`src/routes/webUi.ts`) in production. `web/src/pages/` mirrors the
backend's role model directly — e.g. `ProposalQueuePage.tsx` is gated
client-side the same way `Layout.tsx` gates its own nav links, reusing
`DiffView.tsx` for review across both the audit log and the proposal
queue.

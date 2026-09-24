# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-tenant MCP server bridging Suomi.fi Palvelutietovaranto (PTV —
Finland's national service catalogue) and AI agents. Church organisations
(e.g. parishes) manage their PTV service descriptions through an AI agent;
all writes are two-phase (AI proposes a diff, a human with the right role
approves it) and go through a versioned PTV adapter layer, never straight
from a prompt. Backend is `src/`, a companion Vite/React SPA lives in
`web/`.

Read `docs/plan.md` (architecture rationale, Finnish), `docs/phase-plan.md`
(phase-by-phase build sequence, English), `docs/ptv-v11-notes.md` (PTV v11
API findings), and `PLAN.md`/`EXECUTION_LOG.md` (live checklist and
append-only build log) before making architectural changes — they are the
source of truth for *why* things are built the way they are, and
`EXECUTION_LOG.md` in particular records deviations and known gaps that
aren't obvious from the code alone.

## Commands

Backend (repo root):

```bash
npm run dev               # tsx watch src/server.ts — hot reload
npm test                  # unit tests only (no DB)
npm test -- path/to.test.ts        # single unit test file
npm run test:watch        # vitest watch mode
npm run test:integration  # DB-backed tests (requires a migrated Postgres) — matches files with "integration" in the path
npx vitest run path/to.integration.test.ts   # single integration test file
npm run lint               # eslint .
npm run format             # prettier --check .   (format:write to fix)
npm run typecheck          # tsc --noEmit
npm run build               # tsc -p tsconfig.json
npm run db:generate         # drizzle-kit generate — after editing src/db/schema/*
npm run db:migrate          # tsx src/db/migrate.ts
npm run db:seed             # local dev fixtures
npm run mcp:token           # tsx src/mcp/token.ts — mint a token for manual MCP testing
```

Frontend (`web/`):

```bash
npm --prefix web run dev     # vite dev server
npm --prefix web run build   # tsc -b && vite build
npm --prefix web run lint    # oxlint
```

One-time DB bootstrap (superuser/CREATEROLE connection, never the app's own
role — see `scripts/bootstrap-roles.sql`):

```bash
psql -h localhost -U <superuser> -d ptv_mcp_dev -f scripts/bootstrap-roles.sql
npm run db:migrate
```

CI (`.github/workflows/ci.yml`) runs, in order: `npm run format` → `lint` →
`typecheck` → `npm test` → `web` lint → role bootstrap → `db:migrate` →
`npm run test:integration` → `npm run build` → web build → compose config
check → `docker build .`. A failure early in that chain (e.g. `format`)
skips everything after it — check which step actually ran, not just
whether CI shows red.

## Architecture

### PTV adapter layer (ports & adapters)

PTV exposes multiple, non-interchangeable API versions over its lifetime
(v11 today, v12 rolling out, more later). The whole PTV integration is
built as a ports-and-adapters layer so the rest of the app never touches a
version-specific "wire" shape:

- **`src/ptv/adapter.ts`** — the one `PtvAdapter` interface every version
  implements (`searchServices`, `getService`, `applyServiceChange`, etc.)
  plus `getCapabilities()` (`apiVersion`, `credentialScope`, `supportsRead`
  /`supportsWrite`/`supportsDraftRead`). MCP tools, the diff engine, and
  validation call *only* this interface.
- **`src/ptv/domain.ts`** — the shared internal domain model (`Service`,
  `ServiceChannel` × 5 subtypes, `Organization`, `GeneralDescription`,
  `ServiceCollection`, `Connection`, code lists). Every adapter translates
  its own wire format to/from this model; nothing outside `src/ptv/v11/`
  and `src/ptv/v12/` should see raw PTV JSON.
  version-specific quirks (v11's delete-flag PUT semantics in
  `src/ptv/v11/deleteFlags.ts`, its embedded-connection extraction, its
  OAuth2 consent flow; v12's `x-api-key` auth) stay inside that adapter's
  own directory.
- **`src/ptv/registry.ts` / `src/ptv/dbAdapterRegistry.ts`** —
  `PtvAdapterRegistry` resolves `(tenant, environment, operation,
  actingUser)` to a concrete, already-credentialed adapter instance, by
  reading `PtvAdapterConfig` (which adapter/version is active for this
  tenant+environment) and then pulling credentials from the right table
  per that adapter's declared `credentialScope`. Tenant-role authorization
  is always checked *before* this resolution, never replaced by it.
- **`src/ptv/testing/contractTests.ts`** — one shared test suite run
  against every adapter (including an in-memory fake) so behavior stays
  consistent across versions; run this against any new/changed adapter.
- Adapter bring-up/retirement is a repeatable process, not a one-off —
  see `docs/adapter-onboarding-runbook.md`.

### Credential scopes

Two different tables back `CredentialScope` depending on the adapter:

- `TenantEnvironment` (`src/credentials/tenantEnvironmentService.ts`) —
  tenant-scoped, shared org secret (e.g. v12's API key), envelope-encrypted.
- `UserPtvConnection` (`src/credentials/userPtvConnectionService.ts`) —
  per-user (e.g. v11's OAuth token, since PTV's v11 consent is personal by
  design, not organizational), also envelope-encrypted. A user's PTV
  connection is keyed by `(user_id, api_version, environment)` — read and
  write API version selection for a connection are independent of each
  other; check `src/db/schema/userPtvConnection.ts` and the OAuth routes in
  `src/mcp/oauthRoutes.ts`/`src/routes/ptvConnections.ts` for the current
  shape before assuming there's a single `apiVersion` field.

Envelope encryption itself (`src/security/envelopeEncryption.ts`) wraps a
per-record data key with the environment's `MASTER_ENCRYPTION_KEY`.

### Multi-tenancy and authorization

Tenant isolation is enforced at two layers, deliberately redundant:
application-level `tenant_id` filtering, *and* Postgres Row-Level Security
on every tenant-scoped table (`drizzle/0001_row_level_security.sql`
onward) — a missed `WHERE tenant_id = ...` in application code should
still fail closed. RLS session context is set per-request
(`src/db/context.ts`); `src/db/rls.integration.test.ts` is the place to
add coverage for any new tenant-scoped table.

Roles (`src/auth/rbac.ts`) are Viewer < Contributor < Approver < Publisher <
Tenant Admin (UI: Katselija, Ehdottaja, Hyväksyjä, Julkaisija, Pääkäyttäjä;
see `docs/roles-and-review-plan.md`), scoped per `(user, tenant)` via
`Membership`. Role gates live close to the
operation they guard (e.g. `src/mcp/authorization.ts` for MCP tools) —
grep for `NotAuthorizedError` and `PtvAdapterResolutionError` before adding
a new gated action, since both already-established shapes are checked by
existing tests and mixing them up has caused bugs before (see
`EXECUTION_LOG.md`'s Phase 6 entry).

### Two-phase writes: proposals

`ptv_propose_changes` (`src/mcp/proposalQueue.ts`, Contributor+) persists a
`pending` proposal (`src/db/schema/proposal.ts`) rather than writing
anything. `ptv_resolve_proposal` (Approver+) re-diffs against *current* PTV
state at resolve time — it never trusts the diff stored at queue time
(`queued_diff` is kept only for audit/historical display). Resolving with
`approve_and_export` only needs Approver; `approve_and_apply` additionally
requires the registry to hand back a write-capable adapter for that
tenant/environment (Publisher-only, enforced by `PtvAdapterRegistry`, not
by the proposal code itself). Four-eyes (`tenants.require_four_eyes`, on by
default) additionally refuses approving your own proposal and the direct
`ptv_export_for_manual_publish`/`ptv_apply_changes` tools; integration tests
that exercise those direct tools create their tenant with it off. Required
reviewers (`proposal_reviewers`, `ptv_request_review`/`ptv_sign_off_proposal`)
must all have `approved` before either approve action; reject is always
allowed.

### MCP layer

`src/mcp/mcpServer.ts` wires the real `@modelcontextprotocol/sdk` over a
stateless Streamable HTTP transport (`src/mcp/httpTransport.ts`), auth'd
via OAuth (`src/mcp/oauthService.ts`, `src/mcp/oauthRoutes.ts`). Both
tools and resources build their context off the same verified
`extra.authInfo` — via `toolContext(extra)` for tools (tenant/environment
come from the OAuth token's claims) and `resourceToolContext(extra,
uriTenantId, uriEnvironment)` for resources (tenant/environment instead
come from the resource URI itself, e.g. `ptv://{tenantId}/{environment}/
services/{id}` — resources have no other per-call channel the way tools'
arguments schema does). Both still take the acting user and read/write API
version from the token. Note: MCP **resource** read callbacks intentionally
do *not* use the tools' `try/catch → errorResult` convention, because
`ReadResourceResult` has no `isError` field the way `CallToolResult` does
(thrown errors become JSON-RPC errors instead) — this is a deliberate
protocol-shape difference, not an inconsistency to "fix" by matching tool
error handling.

**MCP OAuth access tokens are not the same token as the web UI's login
session** — this has caused real bugs (fixed 2026-09-20, see
`EXECUTION_LOG.md`). `AuthService.login()`/`signAccessToken()`
(`src/auth/jwt.ts`) produce a plain JWT with only a `sub` claim, meant for
the REST API (`authenticate` preHandler, `src/auth/rbac.ts`). The `/mcp`
endpoint verifies a *different* token via `OAuthService.verifyAccessToken()`
(`src/mcp/oauthService.ts`), which requires matching `iss`/`aud` claims and
carries `tenant_id`/`environment`/`read_api_version`/`write_api_version`
— minted via `OAuthService.issueAccessToken(...)`, normally through the
`/mcp/authorize` consent flow (`src/mcp/oauthRoutes.ts`). **Never use a
login-session token to call `/mcp` in code or tests** — construct an
`OAuthService` with the exact same `(jwtSecret, issuer, resource)` as
`src/app.ts` uses (`issuer === resource === config.mcpPublicUrl`, no
`/mcp` suffix on either) and call `issueAccessToken` directly instead.
A mismatched `resource`/audience between two `OAuthService` instances
(e.g. one minting, another verifying) makes every token silently fail
verification — `npm run mcp:token` (`src/mcp/token.ts`) had exactly this
bug until the same fix.

### Guides, skills and server instructions

`src/mcp/guides.ts` serves the Markdown in `guides/` and `skills/*/SKILL.md`
(read at runtime from the repo root, so the Dockerfile copies both
directories) as the `ptv_get_guide` tool, `ptv-guide://` resources, prompts
and the server's `instructions`. `guides/content-quality.md` condenses
DVV's kehittajille.suomi.fi content guidelines; its `Q-*` checklist IDs
are referenced by the prompts and tests. Keep them stable, and update the
guides rather than hard-coding PTV writing rules in tool descriptions.

### Automated quality checks, review campaigns and the inbox

`src/quality/contentChecks.ts` is the deterministic implementation of the
`Q-*` checks marked *auto* in `guides/content-quality.md`; proposals,
review items and `ptv_check_quality` all use it, so change rules there (and
the guide's markers) rather than in prompts. Review campaigns
(`src/reviews/`, `docs/review-campaigns-plan.md`) turn an organisation's
published content into review items that reviewers confirm or answer with
proposals linked by `proposals.review_item_id`. `ptv_my_tasks`
(`src/mcp/myTasks.ts`) is the pull-style inbox: the stateless MCP
transport has no channel for push notifications.

### Service channels

`ServiceChannel` (`src/ptv/domain.ts`) carries each type's structured
fields (addresses, phone numbers, emails, URLs, service hours, form files,
accessibility). `CHANNEL_TYPE_FIELDS` (`src/mcp/channelProposal.ts`) says
which type writes which. v11 maps them in `src/ptv/v11/channelFields.ts`;
the GET and In shapes differ (see `docs/ptv-v11-notes.md`, "Channel
fields"). `validateChannel` (`src/validation/channelRules.ts`) holds PTV's
hard rules, and `checkChannel` the guideline warnings. New channels are
`channel_create` proposals (`src/mcp/newChannelProposal.ts`).

### Everything else

- `src/app.ts` wires all Fastify plugins/routes together (`buildApp`) —
  the single place that shows how every module is assembled; start here
  when tracing how a request flows end to end.
- `src/audit/auditService.ts` — append-only audit log; every mutating
  action (proposal queue/resolve, credential changes, tenant/membership
  changes) should record one entry with a `correlationId` shared across a
  single logical operation.
- `src/validation/changeValidator.ts` — schema/business-rule validation of
  a proposed change, generated against the active adapter's own schema
  rather than hand-maintained rules.
- Drizzle migrations are sequential and hand-numbered
  (`drizzle/0000_...` → `drizzle/0011_...`); always add a new one via
  `npm run db:generate` after a schema change rather than editing an
  applied migration.

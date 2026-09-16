# Phase Plan: PTV MCP Server

> Companion document to [`docs/plan.md`](./plan.md) (the reviewed
> architecture plan) and [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md) (the
> v11 API review). This sequences the work: what must happen in order,
> what can run in parallel, and where PTV's own external rollout timeline
> — not our build speed — gates further progress.
>
> **Revision note:** earlier versions of this plan treated v12 as the
> primary backend with v11 as an optional bolt-on track ("Track 3B") added
> later and removed at the end. That framing is gone. PTV already has two
> live API generations (v11, v12) and a well-established pattern of
> replacing one with the next — a future v13 is a "when," not an "if." So
> the PTV integration is built from Phase 1 onward as a **ports & adapters
> layer**: one `PtvAdapter` interface, one shared domain model, and
> interchangeable per-version adapters (`PtvV11Adapter`, `PtvV12Adapter`,
> eventually `PtvV13Adapter`) behind it. Onboarding and retiring a version
> is the same repeatable procedure every time, not a one-off.

## Overview

9 phases. Phases 0–6 deliver **MVP-0** and are fully within our control;
they build the adapter layer with **both v11 and v12 as first-class
adapters from the start**, not sequentially. Phases 7–8 (**MVP-1**,
**MVP-2**) extend `PtvV12Adapter` with write support and are blocked on
PTV's own roadmap (write endpoints in test ~10/2026, production ~04/2027).
Because v11 is a live production write path today, **MVP-0 ships with real
production writes** via `PtvV11Adapter` — confirmed workable by checking
`palveluhallinta.suomi.fi`'s live OIDC discovery document directly (see
`docs/ptv-v11-notes.md`): its `token_endpoint` is empty, meaning the
declared implicit grant genuinely is the only mechanism, not unverified
boilerplate. It's a **per-user consent link**, not a background service
credential — the user connects their own PTV account once, reusable across
every tenant they're a Publisher for, and reconnects only when their token
expires (which naturally aligns with the product's existing rule that a
human always approves before anything is written).

Critical path: **Phase 0 → 1 → 2 → 3 → 4 → 6 → (external wait) → 7 →
(external wait) → 8.** Phase 5 (Web UI) hangs off Phase 3 without
lengthening the spine.

## Dependency Map

```
Phase 0 (foundation)
   │
   ▼
Phase 1 (data layer + PtvAdapter contract + domain model)
   │
   ├──────────────────────┬──────────────────────┐
   ▼                      ▼                       │
Phase 2A                Phase 2B                  │
(PtvV12Adapter:          (PtvV11Adapter:           │
 read now, write         read + per-user consent   │
 stubbed for later)       flow + write, credential  │
                          scoped to user not tenant)│
   │                      │                        │
   └──────────┬───────────┘                        │
              ▼                                     │
   Phase 3 (auth / tenant+credentials(v12) /         │
            user-connections(v11) / audit /          │
            adapter registry)                       │
              │                                     │
   ┌──────────┴──────────┐                          │
   ▼                     ▼                          │
Phase 4                Phase 5                      │
(MCP tool layer,       (Web UI: tenant admin         │
 version-agnostic)      credential screen +          │
                        personal "connect PTV")      │
   └──────────┬──────────┘                          │
              ▼                                     │
   Phase 6 (integration hardening & MVP-0 launch) ◄──┘
   (ships with v11 production writes for tenants whose
    Publishers have connected their PTV account)
              │
   ┄┄┄┄┄┄┄┄┄ external gate: PTV ships v12 write, test ┄┄┄┄┄┄┄┄┄┄┄┄
              ▼
   Phase 7 (MVP-1: PtvV12Adapter write, test env)
              │
   ┄┄┄┄┄┄┄┄┄ external gate: PTV ships v12 write, prod ┄┄┄┄┄┄┄┄┄┄┄┄
              ▼
   Phase 8 (MVP-2: PtvV12Adapter write, production
            + retire PtvV11Adapter via the standing runbook)
```

---

## Phase 0: Foundation
**Mode:** Sequential
**Depends on:** none
**Goal:** Repo builds, lints, and runs a health check; Postgres reachable locally.

1. Initialize Node.js ESM/TypeScript project (`"type": "module"`, `moduleResolution: NodeNext`), lint/format/test tooling
2. Docker Compose: Postgres + app container skeleton
3. Fastify app skeleton with `/health` route
4. Env/config loader (per-environment secrets, master-key placeholder)
5. CI pipeline skeleton (lint + test on push)

---

## Phase 1: Data layer, adapter contract, and domain model
**Mode:** Parallel (2 streams)
**Depends on:** Phase 0
**Goal:** Migrations run clean on a fresh DB; the `PtvAdapter` interface
and shared domain model are frozen enough for Phase 2's two adapters to be
built against without churn.

**Stream A — Data layer**
- Schema + migrations: `User`, `Tenant`, `Membership`, `TenantEnvironment`, `PtvAdapterConfig`, `UserPtvConnection`, `AuditEntry`
- `TenantEnvironment` stores **tenant-scoped** credentials as a polymorphic
  encrypted blob (JSON, shape keyed by `api_version`) — this is where
  `PtvV12Adapter`'s static `x-api-key` lives, entered once by a tenant
  admin for the whole organization
- `UserPtvConnection` (new, keyed by `(user_id, api_version, environment)`,
  **not** `tenant_id`) stores `PtvV11Adapter`'s credential: encrypted
  access token, expiry, connected-at, last-introspected-at, revoked-at.
  Confirmed via the live OIDC discovery document that v11's OAuth grant is
  personal (one human's `palveluhallinta.suomi.fi` login, no
  `client_credentials` path exists) — see
  [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md) — so this credential is
  reused across every tenant that user is a Publisher for, never
  duplicated per tenant
- `PtvAdapterConfig` keyed by `(tenant_id, environment, api_version)`:
  `auth_mode`, `credential_scope` (`tenant` | `user` — which table a write
  attempt resolves credentials from), `supports_read`, `supports_write`,
  `supports_draft_read` — `api_version` is a free string, not an enum, so
  adding v13 later never needs a migration
- Row-Level Security policies keyed on `tenant_id` (note: `UserPtvConnection`
  is keyed on `user_id`, not `tenant_id` — RLS here must instead ensure a
  user can only ever read/manage their *own* connection row, not another
  user's, regardless of tenant)
- Seed script for local dev (fake tenants/users)

**Stream B — `PtvAdapter` contract and domain model**
- Define the `PtvAdapter` TypeScript interface: `searchServices`,
  `getService`, `searchChannels`, `getChannel`, `getOrganisation`
  (+hierarchy), `searchServiceCollections`, `searchGeneralDescriptions`,
  `getConnectionsFor(entity)`, `listCodes`, `applyServiceChange`, and
  `getCapabilities()` (what this adapter instance actually supports,
  including `credentialScope: 'tenant' | 'user'`)
- Define the shared **domain model** every adapter maps to/from: `Service`
  (3 subtypes), `ServiceChannel` (5 subtypes: EChannel, Phone,
  PrintableForm, ServiceLocation, WebPage), `Organization`,
  `GeneralDescription`, `ServiceCollection`, `Connection`, code lists —
  MCP tools, the diff engine, and validation only ever touch this model,
  never a version's wire format directly
- Define `PtvAdapterRegistry`'s resolution contract: given `(tenant,
  environment, operation, actingUser)`, return the adapter instance to use
  **and** the correct credential source for it (`TenantEnvironment` for a
  tenant-scoped adapter, `UserPtvConnection` for a user-scoped one) — the
  acting user is now a required input to resolution, not optional
- Write the **contract test suite** stub: a fixture-driven test set that
  any `PtvAdapter` implementation must pass (used in Phase 2's sync point)

**Sync point:** `npm run db:migrate` succeeds on a fresh Postgres; the
`PtvAdapter` interface and domain model compile and are documented; the
contract test suite runs (against a fake in-memory adapter) and is ready
to run against real implementations.

---

## Phase 2: Adapter implementations — v11 and v12, side by side
**Mode:** Parallel (2 streams)
**Depends on:** Phase 1
**Goal:** Both adapters pass the shared contract test suite for reads;
`PtvV11Adapter`'s per-user consent flow works end to end.

**Stream 2A — `PtvV12Adapter`**
- Vendor PTV v12 `openapi.json`, generate wire types + Ajv validators
- Implement read methods (search/get for all content types, code lists)
  against the domain model
- `x-api-key` auth (tenant-scoped, via `TenantEnvironment`), retry/backoff+jitter
- Write methods **stubbed** — implemented against the beta `Post*/Put*`
  schemas already reviewed, but gated off (`supports_write: false`) until
  Phase 7, since the endpoints don't exist yet

**Stream 2B — `PtvV11Adapter`**
(builds on the review in `docs/ptv-v11-notes.md`, including the confirmed
OAuth findings — this is implementation now, not discovery)
- Vendor v11 `swagger.json`, generate wire types
- Implement read methods: ordinary published-content search/get (no
  credentials needed — v11's public GETs are unauthenticated) plus the
  **restricted draft-visibility endpoints** (`Service/active/{id}`,
  `ServiceChannel/active/{id}`), which need a user's PTV connection like
  writes do
- Extract embedded connection data from `Service`/`ServiceChannel`
  payloads (v11 has no dedicated connection-read endpoint)
- **Per-user consent flow**: authorization-link generation, a callback
  page that captures the implicit grant's token from the URL fragment and
  posts it to the backend, introspection-based validation before storing
  it in `UserPtvConnection`, and revocation on disconnect. Confirmed
  against the live `palveluhallinta.suomi.fi` OIDC discovery document that
  this is the *only* mechanism (`token_endpoint` is empty — no
  `client_credentials`/refresh path exists), and that the credential is
  scoped to the individual user, not the tenant
- **Delete-flag mapping table**: v11's PUT is a partial update — a field
  isn't cleared just because it's omitted, an explicit `deleteX: true`
  flag is required per field group. Build and unit-test this mapping
  before wiring any write call
- Wire `PtvAdapterConfig` for `api_version = v11`: `credential_scope =
  user`, `supports_write = true` for `environment = production` (subject
  to Phase 6's staged per-tenant rollout) — no go/no-go gate needed
  anymore, since the mechanism itself is confirmed workable

**Sync point:** the Phase 1 contract test suite passes against both
`PtvV12Adapter` and `PtvV11Adapter` for all read operations; a real human
can click the v11 consent link, land back authenticated, and have
`PtvAdapterRegistry` resolve their stored connection for a write call.

---

## Phase 3: Core platform services
**Mode:** Parallel (4 streams)
**Depends on:** Phase 2
**Goal:** An authenticated request resolves tenant + role, the adapter
registry picks the right adapter, credentials decrypt correctly, and every
action is recorded.

**Stream A — Auth**
- JWT issue/verify, Argon2id hashing, refresh-token rotation + denylist
- Register / login / verify-email / reset-password / logout routes
- RBAC middleware for Reader / Editor / Publisher / Tenant Admin

**Stream B — Tenant & credential management**
- Tenant/membership CRUD
- Envelope-encrypted credential storage for **tenant-scoped** secrets
  (`TenantEnvironment` — v12's API key, entered once by a tenant admin),
  write-only-after-save UI contract
- Envelope-encrypted storage for **user-scoped** connections
  (`UserPtvConnection` — v11's OAuth token), managed by each user for
  themselves, not by a tenant admin on their behalf
- `PtvAdapterConfig` wired to the real DB table

**Stream C — Audit logging**
- Append-only audit-entry write path, correlation IDs, `api_version` and
  `environment` fields so every action records which adapter handled it,
  plus `user_id` for a user-scoped write so PTV's own `userName`
  attribution and our audit trail point at the same person
- Retention + access-restriction policy for `prompt`/`before_state`/`after_state` (GDPR)

**Stream D — Adapter registry**
- Implement `PtvAdapterRegistry`: resolves `(tenant, environment,
  operation, actingUser)` to a concrete adapter instance via
  `PtvAdapterConfig`, then resolves credentials from `TenantEnvironment` or
  `UserPtvConnection` depending on that adapter's declared
  `credentialScope` — tenant-role authorization (is this user a Publisher
  for this tenant?) is checked before the credential lookup, never
  replaced by it
- Liveness/readiness polling per adapter (v12 exposes `/health/*`; v11 has
  no equivalent — handle its absence gracefully)
- v12's `archived` endpoint sync helper for incremental cache invalidation
  (v12-specific, housed inside `PtvV12Adapter`, not the registry itself)

**Sync point:** integration test — log in, resolve tenant + role, the
registry picks the correct adapter, credentials decrypt, a real PTV call
succeeds, and an audit entry is recorded naming the adapter used.

---

## Phase 4: MCP tool layer
**Mode:** Parallel (4 streams)
**Depends on:** Phase 3
**Goal:** An agent can search PTV content (via either adapter, transparently),
propose a change, validate it, and either export it manually or apply it
directly if a write-capable adapter is active for that tenant.

**Stream A — Search tools**
`ptv_search_services`, `ptv_get_service`, `ptv_search_channels`,
`ptv_get_channel`, `ptv_get_organisation` (+hierarchy),
`ptv_search_service_collections`, `ptv_search_general_descriptions`,
`ptv_search_connections`, `ptv_list_codes` — all built against the domain
model via the registry, adapter-agnostic

**Stream B — Propose-changes / diff engine**
`ptv_propose_changes` — operates entirely on the domain model, so it's the
same code whichever adapter served the current state. **Freeze this JSON
contract early** — Phase 5 Stream C builds a UI against it.

**Stream C — Validation engine**
`ptv_validate_changes` — per-adapter rule sets (v11 and v12 field
constraints may differ subtly) registered against one common validator
interface; generated from each adapter's own schemas, not hand-maintained

**Stream D — Apply / export**
- `ptv_export_for_manual_publish` — renders an approved proposal into a
  PTV-UI-ready, per-language format; writes `ReadyForManualPublish` audit
  entries
- `ptv_apply_changes` — asks the registry for a write-capable adapter for
  this tenant/environment and the acting user; for `PtvV11Adapter` this is
  live in MVP-0 for production, provided the acting user has a valid PTV
  connection (prompting "reconnect to PTV" if theirs expired) — otherwise
  it returns a clear "not yet available" error until Phase 7

**Sync point:** end-to-end script — search a real service, propose a
rewrite, validate it, then either export it or apply it directly — with
every step in the audit log naming the adapter involved.

---

## Phase 5: Web UI
**Mode:** Parallel (3 streams)
**Depends on:** Phase 3 (runs alongside Phase 4, not behind it)
**Goal:** Tenant admins can self-serve users, credentials, and audit
visibility without touching the DB.

**Stream A — Auth & tenant/user management UI** (login, org switcher, membership/role editing)
**Stream B — Credential management UI**: two distinct surfaces, not one
generic form — a **tenant admin** screen for `TenantEnvironment` (v12's API
key, masked display, replace-only flow, per environment), and a personal
**"Connect your PTV account"** screen any user visits for themselves (v11's
consent link, connection status, expiry, a disconnect button wired to the
revocation endpoint) — reflecting that the two credentials genuinely live
at different scopes, not just different auth mechanisms
**Stream C — Audit log viewer / proposal review UI** (diff view depends on Phase 4 Stream B's frozen contract — build against a mock if it isn't ready yet)

**Sync point:** a tenant admin can create a user, set their role, and
configure the tenant's v12 API key; a user can connect their own PTV
account for v11; both show up correctly in the audit log.

---

## Phase 6: Integration hardening & MVP-0 launch
**Mode:** Sequential
**Depends on:** Phase 4, Phase 5
**Goal:** Deployable, reviewed, documented MVP-0.

1. End-to-end tests across the full propose → validate → export/apply flow, per role, against both adapters
2. Multi-tenant isolation tests (attempt cross-tenant reads/writes, confirm RLS actually blocks them, not just that policies exist) **and** a same-user-different-tenant test confirming one PTV connection is correctly reusable across every tenant that user is a Publisher for, while still being blocked for tenants they aren't
3. Security review — secrets handling, key rotation, GDPR retention on audit fields, and the v11 OAuth credential lifecycle specifically (token capture via the fragment-reading callback page, introspection validation, revocation on disconnect)
4. Docs: deployment guide, adapter-onboarding/retirement runbook (formalized from Phase 2's process), README
5. Production Docker/Compose config finalized, CI/CD deploy step added
6. Staged rollout of `PtvV11Adapter` write support, tenant by tenant

**This is the MVP-0 ship gate.** MVP-0 ships with real production writes
via v11 for any tenant whose Publishers have connected their PTV account —
tenants where nobody has (yet) fall back to manual export, the same
codebase either way, decided entirely by whether a `UserPtvConnection` row
exists.

---

## Phase 7: MVP-1 — `PtvV12Adapter` write, test environment
**Mode:** Sequential
**Depends on:** Phase 6 **and** PTV publishing v12 write endpoints to its test environment (external, expected ~10/2026)
**Goal:** `ptv_apply_changes` works against PTV's v12 test environment.

1. Re-generate `PtvV12Adapter`'s types/validators once PTV's write OpenAPI schemas are final (they're beta today)
2. Implement the write methods already stubbed in Phase 2A against the real POST/PUT endpoints, test env only
3. Flip `PtvAdapterConfig.supports_write = true` for `api_version = v12`, `environment = test`
4. Idempotency handling for POST (dedup key), retry-safety for PUT
5. Confirm write-path audit entries record `api_version = v12` correctly

---

## Phase 8: MVP-2 — `PtvV12Adapter` write, production; retire `PtvV11Adapter`
**Mode:** Sequential
**Depends on:** Phase 7 **and** PTV publishing v12 write endpoints to production (external, expected ~04/2027)
**Goal:** `ptv_apply_changes` works in production on v12; `PtvV11Adapter` is
decommissioned via the standing runbook, not a bespoke process.

1. Flip `PtvAdapterConfig.supports_write = true` for `api_version = v12`, `environment = production`
2. Final security review specific to production writes
3. **Run the adapter retirement runbook** against `PtvV11Adapter` (same
   procedure documented in Phase 6's docs, and the one that will retire
   `PtvV12Adapter` itself whenever v13 eventually arrives):
   a. Run `PtvV11Adapter` and `PtvV12Adapter` (production) side by side for a transition window
   b. Migrate tenants off v11 one at a time, confirming each on v12 before moving to the next
   c. Once no `PtvAdapterConfig` row references `api_version = v11`: delete `PtvV11Adapter`'s implementation, its type-generation pipeline, and its credential-blob handling
   d. Update docs to remove v11-specific references

---

## Critical Path
Phase 0 → Phase 1 → Phase 2 (both streams — whichever of 2A/2B takes
longer sets the pace; expect 2B's OAuth discovery to dominate, it's the
highest-uncertainty item in the whole plan) → Phase 3 → Phase 4 → Phase 6
→ *(external wait)* → Phase 7 → *(external wait)* → Phase 8

Phase 5 hangs off Phase 3 but never lengthens the spine if resourced
properly.

## Risk Register
- **Adapter interface churn** — if Phase 1's `PtvAdapter` interface is wrong, both Phase 2 adapters need rework simultaneously. Mitigation: freeze it at Phase 1's sync point behind the contract test suite; only additive changes afterward, never breaking ones.
- **v11 tokens can never be refreshed** — confirmed via the live OIDC discovery document (`token_endpoint` is empty), not just an implicit-grant limitation. A user's PTV connection *will* expire mid-workflow eventually. Mitigation: surface "reconnect to PTV" at the exact moment `ptv_apply_changes` needs a valid token, rather than failing with a generic error — the human approving the write is already present, so this is a UI prompt, not a blocker.
- **Per-user credential drifting out of sync with tenant membership** — a user's PTV connection outlives their membership in any particular tenant (it's `user_id`-keyed, not `tenant_id`-keyed), so removing them from a tenant in our system must be enforced at the authorization check, not by assuming the credential itself disappears. Mitigation: `PtvAdapterRegistry` always re-checks tenant/role membership at call time, never caches "this user could write here" from a past check.
- **v11's partial-update semantics** — PUT requests don't clear a field just because it's omitted; each field group needs an explicit `deleteX: true` flag. Mitigation: build and unit-test the delete-flag mapping table in Phase 2B before wiring `ptv_apply_changes`'s diff-to-request translation.
- **PTV's v12 write-schema beta churn** — the Post/Put schemas used in Phase 2A/4C are still beta; a shape change before Phase 7 requires re-generating types. Mitigation: pin the OpenAPI JSON version, diff on every re-fetch.
- **RLS false confidence** — RLS policies wrongly scoped (e.g., missing on a join table) silently reintroduce the cross-tenant leak they're meant to prevent. Mitigation: Phase 6's isolation tests must attempt real cross-tenant access, not just check policy existence.
- **Phase 5 Stream C / Phase 4 Stream B contract drift** — UI diff viewer built against a guessed shape before the diff engine is final. Mitigation: freeze the diff JSON contract at the start of Phase 4/5, not at their sync point.
- **External-gate slippage** — PTV's 10/2026 and 04/2027 dates are the vendor's own projected roadmap, not commitments. Mitigation: keep Phase 7/8 fully spec'd but don't staff them until PTV's test/prod environments actually expose the endpoints — check via a scheduled probe against the live OpenAPI JSON rather than trusting the calendar.
- **v11/v12 cutover risk (Phase 8)** — removing v11 before every tenant is confirmed working on v12 production risks breaking live publishing for whoever's still on it. Mitigation: the side-by-side transition window and per-tenant migration in Phase 8 step 3 are not optional, even under schedule pressure.
- **The runbook itself is unproven the first time** — Phase 8 is the first real run of the adapter retirement procedure; if it's harder than expected, that's a lesson for v12's own eventual retirement, not just a one-off cost. Mitigation: write down what actually happened in Phase 8, not just what was planned, so the v13 transition benefits from it.

## Recommended Starting Point
Phase 0, step 1 — the ESM/TypeScript scaffold gates literally everything
else. As soon as Phase 1's sync point is reached (interface + domain model
frozen, contract test suite runnable), start both Phase 2 streams
immediately and in parallel — there's no reason to build v12 first and
bolt v11 on afterward. Phase 2B's per-user consent flow is worth building
early regardless, since it's real, shippable production-write capability
and no longer has an open feasibility question hanging over it.

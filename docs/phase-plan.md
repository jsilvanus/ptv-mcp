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
Because v11 is a live production write path today, **MVP-0 itself may
already ship with real production writes** via `PtvV11Adapter` — contingent
on a single, hard, early gate: whether v11's declared OAuth2 `implicit`
grant (its scope name looks like unmodified IdentityServer4 boilerplate —
see `docs/ptv-v11-notes.md`) is actually usable by an unattended backend.
That gate sits in Phase 2, before any adapter write-path code is built.

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
 read now, write         read + OAuth grant-type   │
 stubbed for later)       discovery + go/no-go     │
                          for write)                │
   │                      │                        │
   └──────────┬───────────┘                        │
              ▼                                     │
   Phase 3 (auth / tenant+credentials / audit /      │
            adapter registry)                       │
              │                                     │
   ┌──────────┴──────────┐                          │
   ▼                     ▼                          │
Phase 4                Phase 5                      │
(MCP tool layer,       (Web UI)                      │
 version-agnostic)                                  │
   └──────────┬──────────┘                          │
              ▼                                     │
   Phase 6 (integration hardening & MVP-0 launch) ◄──┘
   (ships with v11 production writes if Phase 2B passed go/no-go)
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
- Schema + migrations: `User`, `Tenant`, `Membership`, `TenantEnvironment`, `PtvAdapterConfig`, `AuditEntry`
- `TenantEnvironment` stores credentials as a **polymorphic encrypted
  blob** (JSON, shape keyed by `api_version`) — v12 needs a static
  `x-api-key` string, v11 needs OAuth2 client/token state (exact shape
  depends on Phase 2B's grant-type finding)
- `PtvAdapterConfig` keyed by `(tenant_id, environment, api_version)`:
  `auth_mode`, `supports_read`, `supports_write`, `supports_draft_read` —
  `api_version` is a free string, not an enum, so adding v13 later never
  needs a migration
- Row-Level Security policies keyed on `tenant_id`
- Seed script for local dev (fake tenants/users)

**Stream B — `PtvAdapter` contract and domain model**
- Define the `PtvAdapter` TypeScript interface: `searchServices`,
  `getService`, `searchChannels`, `getChannel`, `getOrganisation`
  (+hierarchy), `searchServiceCollections`, `searchGeneralDescriptions`,
  `getConnectionsFor(entity)`, `listCodes`, `applyServiceChange`, and
  `getCapabilities()` (what this adapter instance actually supports)
- Define the shared **domain model** every adapter maps to/from: `Service`
  (3 subtypes), `ServiceChannel` (5 subtypes: EChannel, Phone,
  PrintableForm, ServiceLocation, WebPage), `Organization`,
  `GeneralDescription`, `ServiceCollection`, `Connection`, code lists —
  MCP tools, the diff engine, and validation only ever touch this model,
  never a version's wire format directly
- Define `PtvAdapterRegistry`'s resolution contract: given
  `(tenant, environment, operation)`, return the adapter instance to use
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
**Goal:** Both adapters pass the shared contract test suite for reads; the
v11 write go/no-go is decided before any write code is built.

**Stream 2A — `PtvV12Adapter`**
- Vendor PTV v12 `openapi.json`, generate wire types + Ajv validators
- Implement read methods (search/get for all content types, code lists)
  against the domain model
- `x-api-key` auth, retry/backoff+jitter
- Write methods **stubbed** — implemented against the beta `Post*/Put*`
  schemas already reviewed, but gated off (`supports_write: false`) until
  Phase 7, since the endpoints don't exist yet

**Stream 2B — `PtvV11Adapter`**
(builds on the review in `docs/ptv-v11-notes.md`)
- Vendor v11 `swagger.json`, generate wire types
- Implement read methods: ordinary published-content search/get (no
  credentials needed — v11's public GETs are unauthenticated) plus the
  **restricted draft-visibility endpoints** (`Service/active/{id}`,
  `ServiceChannel/active/{id}`) for tenants that need to see PTV drafts
- Extract embedded connection data from `Service`/`ServiceChannel`
  payloads (v11 has no dedicated connection-read endpoint)
- **OAuth2 grant-type discovery spike**: register or find documentation
  for a real client against `palveluhallinta.suomi.fi`; determine whether
  an unattended backend can actually obtain and refresh tokens, since the
  spec's declared `implicit` grant (with an IdentityServer4-boilerplate
  scope name) is suspect
- **Delete-flag mapping table**: v11's PUT is a partial update — a field
  isn't cleared just because it's omitted, an explicit `deleteX: true`
  flag is required per field group. Build and unit-test this mapping
  before wiring any write call
- **Go/no-go decision**, feeding directly into `PtvAdapterConfig`:
  - **Go** → `supports_write: true` for `api_version = v11`,
    `environment = production`, gated per-tenant rollout in Phase 6
  - **No-go** (grant genuinely requires a human in the loop) →
    `PtvV11Adapter` ships **read-only**; MVP-0's manual export remains the
    only production write path until Phase 7

**Sync point:** the Phase 1 contract test suite passes against both
`PtvV12Adapter` and `PtvV11Adapter` for all read operations; the v11
go/no-go is documented and `PtvAdapterConfig`'s seed data reflects it.

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
- Envelope-encrypted credential storage handling both adapters' shapes
  (v12 API key, v11 OAuth2 client/token state), write-only-after-save UI
  contract
- `PtvAdapterConfig` wired to the real DB table

**Stream C — Audit logging**
- Append-only audit-entry write path, correlation IDs, `api_version` and
  `environment` fields so every action records which adapter handled it
- Retention + access-restriction policy for `prompt`/`before_state`/`after_state` (GDPR)

**Stream D — Adapter registry**
- Implement `PtvAdapterRegistry`: resolves `(tenant, environment,
  operation)` to a concrete adapter instance via `PtvAdapterConfig`
- Liveness/readiness polling per adapter (v12 exposes `/health/*`; v11 has
  no equivalent — handle its absence gracefully)
- v12's `archived` endpoint sync helper for incremental cache invalidation
  (v11-specific, housed inside `PtvV12Adapter`, not the registry itself)

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
  this tenant/environment; if `PtvV11Adapter` passed its go/no-go, this is
  live in MVP-0 for production; otherwise it returns a clear
  "not yet available" error until Phase 7

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
**Stream B — Credential management UI** (masked display, replace-only flow, per-environment, form adapts to `auth_mode` — API key field for v12, OAuth client setup for v11)
**Stream C — Audit log viewer / proposal review UI** (diff view depends on Phase 4 Stream B's frozen contract — build against a mock if it isn't ready yet)

**Sync point:** a tenant admin can create a user, set their role, configure
credentials for whichever adapters are active, and see actions in the
audit log, all from the UI.

---

## Phase 6: Integration hardening & MVP-0 launch
**Mode:** Sequential
**Depends on:** Phase 4, Phase 5
**Goal:** Deployable, reviewed, documented MVP-0.

1. End-to-end tests across the full propose → validate → export/apply flow, per role, against both adapters
2. Multi-tenant isolation tests (attempt cross-tenant reads/writes, confirm RLS actually blocks them, not just that policies exist)
3. Security review — secrets handling, key rotation, GDPR retention on audit fields, and (if Phase 2B went "go") the v11 OAuth credential lifecycle specifically
4. Docs: deployment guide, adapter-onboarding/retirement runbook (formalized from Phase 2's process), README
5. Production Docker/Compose config finalized, CI/CD deploy step added
6. Staged rollout of `PtvV11Adapter` write support, tenant by tenant, if Phase 2B passed go/no-go

**This is the MVP-0 ship gate.** Depending on Phase 2B's outcome, MVP-0
ships either with real production writes (via v11) or with manual export
only — the same codebase, decided entirely by `PtvAdapterConfig`.

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
- **v11's declared OAuth flow may not be real** — its spec declares the `implicit` grant with a boilerplate-looking scope, which if taken literally would require a human in the loop for token refresh. Mitigation: Phase 2B's discovery spike is a hard go/no-go gate before any write code is built; a no-go doesn't block the phase, it just ships `PtvV11Adapter` read-only.
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
bolt v11 on afterward, and starting v11's OAuth discovery early is exactly
the fail-fast move given it's the plan's biggest unknown.

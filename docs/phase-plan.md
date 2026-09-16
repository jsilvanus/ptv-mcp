# Phase Plan: PTV MCP Server

> Companion document to [`docs/plan.md`](./plan.md) (the reviewed
> architecture plan) and [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md) (the
> v11 API review). This sequences the work: what must happen in order,
> what can run in parallel, and where PTV's own external rollout timeline
> — not our build speed — gates further progress.
>
> **Revision note (2026-09-16, second pass):** the previous version of
> this plan built `PtvV11Adapter` and `PtvV12Adapter` side by side from
> Phase 2 onward. That's now changed: **v11 is built first, all the way
> through MVP-0's launch; `PtvV12Adapter` is a dedicated phase that starts
> only after MVP-0 ships.** The `PtvAdapter` interface and shared domain
> model (Phase 1) stay exactly as version-agnostic as before — this is a
> resequencing of *when* each adapter gets built, not a change to the
> ports-and-adapters architecture itself. Reasoning: v11 alone is enough
> for a fully functioning, real-production-writing MCP server, and
> building it alone first gets that shipped sooner than coordinating two
> adapters at once for a v12 write capability that won't even exist until
> PTV ships it. v12 remains a planned migration, not a parallel track.

## Overview

10 phases. Phases 0–6 build and ship **MVP-0 on `PtvV11Adapter` alone** —
this is a complete, real product: search, propose, validate, export, and
genuine production writes via v11's per-user OAuth consent flow (confirmed
workable against the live discovery document — see
`docs/ptv-v11-notes.md`). Phase 7 adds `PtvV12Adapter` as its own phase,
started only once MVP-0 is live. Phases 8–9 (**MVP-1**, **MVP-2**) extend
`PtvV12Adapter` with write support and remain blocked on PTV's own roadmap
(write endpoints in test ~10/2026, production ~04/2027).

Critical path: **Phase 0 → 1 → 2 → 3 → 4 → 6 → 7 → (external wait) → 8 →
(external wait) → 9.** Phase 5 (Web UI) hangs off Phase 3 without
lengthening the spine.

## Dependency Map

```
Phase 0 (foundation)
   │
   ▼
Phase 1 (data layer + PtvAdapter contract + domain model — version-agnostic)
   │
   ▼
Phase 2 (PtvV11Adapter: read, per-user consent flow, write)
   │
   ▼
Phase 3 (auth / user-connections(v11) / audit / adapter registry)
   │
   ┌──────────┴──────────┐
   ▼                     ▼
Phase 4                Phase 5
(MCP tool layer,       (Web UI: personal
 version-agnostic,      "connect PTV" screen,
 exercised via v11)     tenant/user/audit UI)
   └──────────┬──────────┘
              ▼
   Phase 6 (integration hardening & MVP-0 launch)
   ⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵⟵ MVP-0 SHIPS, v11-only ⟵⟵⟵
              │
              ▼
   Phase 7 (PtvV12Adapter: read + write-stubbed,
            tenant-admin API-key UI — the first real
            run of the adapter onboarding runbook)
              │
   ┄┄┄┄┄┄┄┄┄ external gate: PTV ships v12 write, test ┄┄┄┄┄┄┄┄┄┄┄┄
              ▼
   Phase 8 (MVP-1: PtvV12Adapter write, test env)
              │
   ┄┄┄┄┄┄┄┄┄ external gate: PTV ships v12 write, prod ┄┄┄┄┄┄┄┄┄┄┄┄
              ▼
   Phase 9 (MVP-2: PtvV12Adapter write, production
            + retire PtvV11Adapter via the standing runbook)
```

---

## Phase 0: Foundation ✅ 🔒 (done)
**Mode:** Sequential
**Goal:** Repo builds, lints, and runs a health check; Postgres reachable locally.

Node/TypeScript/Fastify scaffold, lint/format/test tooling, Docker Compose
+ CI skeleton, env/config loader. See `EXECUTION_LOG.md` for the full
verification record.

---

## Phase 1: Data layer, adapter contract, and domain model ✅ 🔒 (done)
**Mode:** Parallel (2 streams, both closed)
**Goal:** Migrations run clean on a fresh DB; the `PtvAdapter` interface
and shared domain model are frozen enough for Phase 2 to build against.

Delivered: full Drizzle schema (`User`, `Tenant`, `Membership`,
`TenantEnvironment`, `PtvAdapterConfig`, `UserPtvConnection`,
`AuditEntry`) with Row-Level Security verified against the real runtime
role; the `PtvAdapter` interface, domain model, and `PtvAdapterRegistry`
resolution contract; a reusable contract-test suite validated against an
in-memory fake. **Nothing here assumed v11-first sequencing** — the schema
and interface were already built polymorphic/version-agnostic, so this
resequencing required no changes to Phase 1's locked output. See
`EXECUTION_LOG.md` for the full verification record.

---

## Phase 2: `PtvV11Adapter` implementation
**Mode:** Sequential internally (see note on internal parallelizable work below)
**Depends on:** Phase 1
**Goal:** `PtvV11Adapter` passes the Phase 1 contract test suite for all
read operations, and a real human can complete the per-user consent flow
end to end and have a resolvable, working write credential.

(builds on the review in `docs/ptv-v11-notes.md`, including the confirmed
OAuth findings — this is implementation now, not discovery)

1. Vendor v11 `swagger.json`, generate wire types
2. Implement read methods: ordinary published-content search/get (no
   credentials needed — v11's public GETs are unauthenticated) plus the
   **restricted draft-visibility endpoints** (`Service/active/{id}`,
   `ServiceChannel/active/{id}`), which need a user's PTV connection like
   writes do
3. Extract embedded connection data from `Service`/`ServiceChannel`
   payloads (v11 has no dedicated connection-read endpoint)
4. **Per-user consent flow**: authorization-link generation, a callback
   page that captures the implicit grant's token from the URL fragment and
   posts it to the backend, introspection-based validation before storing
   it in `UserPtvConnection`, and revocation on disconnect. Confirmed
   against the live `palveluhallinta.suomi.fi` OIDC discovery document
   that this is the *only* mechanism (`token_endpoint` is empty — no
   `client_credentials`/refresh path exists), and that the credential is
   scoped to the individual user, not the tenant
5. **Delete-flag mapping table**: v11's PUT is a partial update — a field
   isn't cleared just because it's omitted, an explicit `deleteX: true`
   flag is required per field group. Build and unit-test this mapping
   before wiring any write call
6. Implement `applyServiceChange` against v11's POST/PUT endpoints, using
   the delete-flag mapping from step 5
7. Wire `PtvAdapterConfig` for `api_version = v11`: `credential_scope =
   user`, `supports_write = true` for `environment = production` (subject
   to Phase 6's staged per-tenant rollout)

**Internal parallelization note:** steps 1 (type generation), 4 (consent
flow), and 5 (delete-flag mapping) have few interdependencies once the
Phase 1 domain model is fixed, and can be worked concurrently — e.g., the
consent flow's auth/callback/introspection code and the delete-flag
mapping's schema research don't touch the same files and don't block each
other. Steps 2, 3, and 6 depend on step 1's generated types and should
follow it.

**Sync point:** the Phase 1 contract test suite passes against
`PtvV11Adapter` for all read operations; a real human can click the
consent link, land back authenticated, and have `PtvAdapterRegistry`
resolve their stored connection for a write call.

---

## Phase 3: Core platform services
**Mode:** Parallel (4 streams)
**Depends on:** Phase 2
**Goal:** An authenticated request resolves tenant + role, the adapter
registry picks `PtvV11Adapter`, credentials decrypt correctly, and every
action is recorded.

**Stream A — Auth**
- JWT issue/verify, Argon2id hashing, refresh-token rotation + denylist
- Register / login / verify-email / reset-password / logout routes
- RBAC middleware for Reader / Editor / Publisher / Tenant Admin

**Stream B — Tenant & credential management**
- Tenant/membership CRUD
- Envelope-encrypted storage for **user-scoped** connections
  (`UserPtvConnection` — v11's OAuth token), managed by each user for
  themselves
- `PtvAdapterConfig` wired to the real DB table
- `TenantEnvironment` (v12's future tenant-scoped API key) gets its table
  and encryption plumbing exercised by tests, but **no UI or write path
  yet** — nothing populates it until Phase 7's `PtvV12Adapter` exists to
  use it. Building the storage layer generically now and its UI later
  (Phase 7) avoids shipping a credential-entry screen for an adapter that
  doesn't exist.

**Stream C — Audit logging**
- Append-only audit-entry write path, correlation IDs, `api_version` and
  `environment` fields so every action records which adapter handled it,
  plus `user_id` for a user-scoped write so PTV's own `userName`
  attribution and our audit trail point at the same person

**Stream D — Adapter registry**
- Implement `PtvAdapterRegistry`: resolves `(tenant, environment,
  operation, actingUser)` to a concrete adapter instance via
  `PtvAdapterConfig`, then resolves credentials from `TenantEnvironment` or
  `UserPtvConnection` depending on that adapter's declared
  `credentialScope` — tenant-role authorization (is this user a Publisher
  for this tenant?) is checked before the credential lookup, never
  replaced by it. **Test both credential-scope branches now**, even
  though only `PtvV11Adapter` (user-scoped) is real — the Phase 1
  in-memory fake already supports a `credentialScope: 'tenant'`
  configuration, so the tenant-scoped resolution path can be verified
  today instead of waiting for Phase 7.
- Liveness/readiness polling for the active adapter

**Sync point:** integration test — log in, resolve tenant + role, the
registry picks `PtvV11Adapter`, credentials decrypt, a real PTV call
succeeds, and an audit entry is recorded naming the adapter used.

---

## Phase 4: MCP tool layer
**Mode:** Parallel (4 streams)
**Depends on:** Phase 3
**Goal:** An agent can search PTV content, propose a change, validate it,
and either export it manually or apply it directly via v11.

**Stream A — Search tools**
`ptv_search_services`, `ptv_get_service`, `ptv_search_channels`,
`ptv_get_channel`, `ptv_get_organisation` (+hierarchy),
`ptv_search_service_collections`, `ptv_search_general_descriptions`,
`ptv_search_connections`, `ptv_list_codes` — built against the domain
model via the registry. Written adapter-agnostic on principle (this is
what makes Phase 7 additive rather than a rewrite), but only exercised
against `PtvV11Adapter` for now.

**Stream B — Propose-changes / diff engine**
`ptv_propose_changes` — operates entirely on the domain model. **Freeze
this JSON contract early** — Phase 5 Stream C builds a UI against it.

**Stream C — Validation engine**
`ptv_validate_changes` — generated from `PtvV11Adapter`'s own schemas
(via the delete-flag-aware write model from Phase 2), registered against
a common validator interface so a second rule set (v12's) can be added in
Phase 7 without restructuring this stream's output.

**Stream D — Apply / export**
- `ptv_export_for_manual_publish` — renders an approved proposal into a
  PTV-UI-ready, per-language format; writes `ReadyForManualPublish` audit
  entries
- `ptv_apply_changes` — asks the registry for a write-capable adapter for
  this tenant/environment and the acting user; live in MVP-0 for
  production via v11, provided the acting user has a valid PTV connection
  (prompting "reconnect to PTV" if theirs expired)

**Sync point:** end-to-end script — search a real service via v11, propose
a rewrite, validate it, then either export it or apply it directly — with
every step in the audit log.

---

## Phase 5: Web UI
**Mode:** Parallel (3 streams)
**Depends on:** Phase 3 (runs alongside Phase 4, not behind it)
**Goal:** Tenant admins can self-serve users and audit visibility; any
user can connect their own PTV account, without touching the DB.

**Stream A — Auth & tenant/user management UI** (login, org switcher, membership/role editing)
**Stream B — Credential management UI**: only the personal
**"Connect your PTV account"** screen (v11's consent link, connection
status, expiry, a disconnect button wired to the revocation endpoint) —
the tenant-admin API-key screen for v12 is **not built yet**; it moves to
Phase 7 alongside `PtvV12Adapter` itself, since there's nothing for it to
configure until then.
**Stream C — Audit log viewer / proposal review UI** (diff view depends on Phase 4 Stream B's frozen contract — build against a mock if it isn't ready yet)

**Sync point:** a tenant admin can create a user and set their role; a
user can connect their own PTV account; both show up correctly in the
audit log.

---

## Phase 6: Integration hardening & MVP-0 launch
**Mode:** Sequential
**Depends on:** Phase 4, Phase 5
**Goal:** Deployable, reviewed, documented, **v11-only** MVP-0.

1. End-to-end tests across the full propose → validate → export/apply flow, per role
2. Multi-tenant isolation tests (attempt cross-tenant reads/writes, confirm RLS actually blocks them, not just that policies exist) **and** a same-user-different-tenant test confirming one PTV connection is correctly reusable across every tenant that user is a Publisher for, while still being blocked for tenants they aren't
3. Security review — secrets handling, key rotation, GDPR retention on audit fields, and the v11 OAuth credential lifecycle specifically (token capture via the fragment-reading callback page, introspection validation, revocation on disconnect)
4. Docs: deployment guide, the **adapter onboarding runbook** (formalize the steps Phase 2 actually followed to bring `PtvV11Adapter` online — Phase 7 will run this same runbook for `PtvV12Adapter`), README
5. Production Docker/Compose config finalized, CI/CD deploy step added
6. Staged rollout of `PtvV11Adapter` write support, tenant by tenant

**This is the MVP-0 ship gate.** MVP-0 ships as a complete product on
`PtvV11Adapter` alone — real search, real proposals, real production
writes for any tenant whose Publishers have connected their PTV account,
manual export as the fallback for tenants where nobody has yet. `v12`
does not exist in the shipped system at all; that's Phase 7, deliberately
starting only now.

---

## Phase 7: `PtvV12Adapter` implementation (post-MVP-0)
**Mode:** Sequential internally
**Depends on:** Phase 6 (MVP-0 must be live — this phase adds a second
adapter to a running product, not a redesign of it)
**Goal:** `PtvV12Adapter` passes the Phase 1 contract test suite for
reads; a tenant admin can configure a v12 API key; write support exists
in code but stays gated off until PTV actually ships it.

This is the first real run of the **adapter onboarding runbook** written
in Phase 6 — worth treating as a validation of that runbook, not just as
"build the second adapter."

1. Vendor PTV v12 `openapi.json`, generate wire types + Ajv validators
2. Implement read methods (search/get for all content types, code lists)
   against the domain model
3. `x-api-key` auth (tenant-scoped, via `TenantEnvironment`), retry/backoff+jitter
4. Write methods **implemented against the beta `Post*/Put*` schemas**
   already reviewed, but gated off (`supports_write: false` in
   `PtvAdapterConfig`) — the endpoints don't exist yet, so this is written
   and unit-tested against the beta schema shapes, not integration-tested
   against a live endpoint
5. Build the **tenant-admin API-key management UI** (`TenantEnvironment`)
   deferred from Phase 5 — this is the first thing that actually needs it
6. Run the Phase 1 contract test suite against `PtvV12Adapter`
7. Pilot: let one tenant configure a v12 key and confirm real v12 search
   results flow through the same MCP tools Phase 4 already built,
   unchanged — this is the payoff of the adapter-agnostic tool layer

**Sync point:** the Phase 1 contract test suite passes against
`PtvV12Adapter` for all read operations; a tenant admin can enter a v12
API key through the UI and see it used for real searches; `PtvV11Adapter`
continues operating unaffected throughout.

---

## Phase 8: MVP-1 — `PtvV12Adapter` write, test environment
**Mode:** Sequential
**Depends on:** Phase 7 **and** PTV publishing v12 write endpoints to its test environment (external, expected ~10/2026)
**Goal:** `ptv_apply_changes` works against PTV's v12 test environment.

1. Re-generate `PtvV12Adapter`'s types/validators once PTV's write OpenAPI schemas are final (they're beta today)
2. Confirm the write methods built (but gated off) in Phase 7 step 4 against the real POST/PUT endpoints, test env only — adjust for any drift between the beta schemas and the final ones
3. Flip `PtvAdapterConfig.supports_write = true` for `api_version = v12`, `environment = test`
4. Idempotency handling for POST (dedup key), retry-safety for PUT
5. Confirm write-path audit entries record `api_version = v12` correctly

---

## Phase 9: MVP-2 — `PtvV12Adapter` write, production; retire `PtvV11Adapter`
**Mode:** Sequential
**Depends on:** Phase 8 **and** PTV publishing v12 write endpoints to production (external, expected ~04/2027)
**Goal:** `ptv_apply_changes` works in production on v12; `PtvV11Adapter` is
decommissioned via the standing runbook, not a bespoke process.

1. Flip `PtvAdapterConfig.supports_write = true` for `api_version = v12`, `environment = production`
2. Final security review specific to production writes
3. **Run the adapter retirement runbook** against `PtvV11Adapter` (the
   counterpart to Phase 7's onboarding runbook, and the one that will
   retire `PtvV12Adapter` itself whenever v13 eventually arrives):
   a. Run `PtvV11Adapter` and `PtvV12Adapter` (production) side by side for a transition window
   b. Migrate tenants off v11 one at a time, confirming each on v12 before moving to the next
   c. Once no `PtvAdapterConfig` row references `api_version = v11`: delete `PtvV11Adapter`'s implementation, its type-generation pipeline, and its credential-blob handling
   d. Update docs to remove v11-specific references

---

## Critical Path
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 6 → Phase 7 →
*(external wait)* → Phase 8 → *(external wait)* → Phase 9

Phase 5 hangs off Phase 3 but never lengthens the spine if resourced
properly. Phase 7 is now squarely on the critical path (it wasn't, in the
old side-by-side plan) — it's the price of shipping MVP-0 faster on v11
alone; nothing about it can start before Phase 6 ships.

## Risk Register
- **Sequencing risk this revision introduces**: MVP-0 launches with a single point of PTV integration (`PtvV11Adapter`). If v11 has an undiscovered limitation that only surfaces at scale or under a specific tenant's data shape, there's no v12 fallback yet — unlike the old side-by-side plan. Mitigation: Phase 6's hardening pass and staged per-tenant rollout exist precisely to surface this before broad launch; the manual-export path remains available per-tenant as a fallback that doesn't depend on any adapter at all.
- **Adapter interface churn** — if Phase 1's `PtvAdapter` interface turns out wrong once a second real adapter (Phase 7) is built against it, that's a rework across both adapters simultaneously. Mitigation: the interface is frozen behind the contract test suite; Phase 7 running that same suite against `PtvV12Adapter` is the actual test of whether the interface generalized correctly — treat any needed change there as a signal to re-examine, not just patch around.
- **v11 tokens can never be refreshed** — confirmed via the live OIDC discovery document (`token_endpoint` is empty), not just an implicit-grant limitation. A user's PTV connection *will* expire mid-workflow eventually. Mitigation: surface "reconnect to PTV" at the exact moment `ptv_apply_changes` needs a valid token, rather than failing with a generic error.
- **Per-user credential drifting out of sync with tenant membership** — a user's PTV connection outlives their membership in any particular tenant (it's `user_id`-keyed, not `tenant_id`-keyed), so removing them from a tenant in our system must be enforced at the authorization check, not by assuming the credential itself disappears. Mitigation: `PtvAdapterRegistry` always re-checks tenant/role membership at call time, never caches a past check.
- **v11's partial-update semantics** — PUT requests don't clear a field just because it's omitted; each field group needs an explicit `deleteX: true` flag. Mitigation: build and unit-test the delete-flag mapping table in Phase 2 before wiring `ptv_apply_changes`'s diff-to-request translation.
- **PTV's v12 write-schema beta churn** — the Post/Put schemas used in Phase 7/8 are still beta; a shape change before Phase 8 requires re-generating types. Mitigation: pin the OpenAPI JSON version, diff on every re-fetch.
- **RLS false confidence** — RLS policies wrongly scoped silently reintroduce the cross-tenant leak they're meant to prevent. Mitigation: Phase 6's isolation tests must attempt real cross-tenant access, not just check policy existence.
- **Phase 5 Stream C / Phase 4 Stream B contract drift** — UI diff viewer built against a guessed shape before the diff engine is final. Mitigation: freeze the diff JSON contract at the start of Phase 4/5.
- **External-gate slippage** — PTV's 10/2026 and 04/2027 dates are the vendor's own projected roadmap, not commitments. Mitigation: keep Phase 8/9 fully spec'd but don't staff them until PTV's test/prod environments actually expose the endpoints.
- **v11/v12 cutover risk (Phase 9)** — removing v11 before every tenant is confirmed working on v12 production risks breaking live publishing for whoever's still on it. Mitigation: the side-by-side transition window and per-tenant migration in Phase 9 step 3 are not optional.
- **Both runbooks are unproven the first time** — Phase 7 is the first real run of the onboarding runbook, Phase 9 the first real run of the retirement runbook. Mitigation: write down what actually happened in each, not just what was planned, so a future v13 transition benefits from both.

## Recommended Starting Point
Phase 2, step 1 — Phases 0 and 1 are done and locked. Within Phase 2,
start the type generation (step 1) first since steps 2/3/6 depend on it,
but kick off the consent-flow work (step 4) and the delete-flag mapping
research (step 5) alongside it rather than after — they don't share files
or depend on the generated types, so there's no reason to serialize them
behind type generation.

# Phase Plan: PTV MCP Server

> Companion document to [`docs/plan.md`](./plan.md) (the reviewed architecture
> plan). This sequences the work: what must happen in order, what can run in
> parallel, and where PTV's own external rollout timeline — not our build
> speed — gates further progress.

## Overview

8 numbered phases, plus one parallel track (3B) for v11 write support.
Phases 0–5 deliver **MVP-0** (search, propose-changes, diff, validation,
manual export — no direct PTV writes) and are fully within our control.
Phases 6–7 (**MVP-1**, **MVP-2**) enable `ptv_apply_changes` against PTV's
**v12** write API and are blocked on PTV's own roadmap (write endpoints in
test ~10/2026, production ~04/2027) — they're fully specced now but can't
start early no matter how fast the rest of the plan moves.

Track **3B** adds `ptv_apply_changes` against PTV's **v11** write API — the
API organisations currently use for production writes, whose only fixed
deadline is PTV's planned 04/2027 sunset (same document PTV published: `04/2027`
= v12 write GA in production *and* v11 fully retired). Because v11 is live
today, this track can deliver production writes **well before** Phase 7's
v12-based MVP-2 — but it starts from a genuine unknown (v11's auth model
and write-request shapes haven't been reviewed, unlike v12's beta schemas),
so it opens with a discovery spike and a go/no-go gate before any adapter
code is written. It is retired again inside Phase 7, once v12 production
write is proven and tenants have migrated off it.

Critical path: **Phase 0 → 1A → 2 → 3 → 5 → (external wait) → 6 → (external
wait) → 7.** Phase 1B, Phase 4, and Track 3B all hang off this spine without
lengthening it — they're what to cut first if the internal timeline needs
compressing.

## Dependency Map

```
Phase 0 (foundation)
   │
   ├──> Phase 1A (DB schema + RLS, polymorphic credential blob) ─┐
   ├──> Phase 1B (PTV v12 client + type gen)                     │
   └──> Phase 1C (v11 discovery spike — informs 1A's schema)     │
                                                                   ▼
                                       Phase 2 (auth / tenant+keys / audit / capability-gate)
                                                                   │
                        ┌──────────────────────┬───────────────────┴───────────────┐
                        ▼                      ▼                                    ▼
                Phase 3 (MCP tool layer)  Phase 4 (Web UI)              Track 3B (v11 write adapter)
                        │                      │                                    │
                        └──────────┬───────────┘                                    │
                                   ▼                                                │
                       Phase 5 (integration & MVP-0 launch)                         │
                                   │                                                │
                                   │            (production writes live via v11, independently)
                     ┄┄┄┄┄┄┄┄┄ external gate: PTV ships v12 write, test ┄┄┄┄┄┄┄┄┄┄┄┄
                                   ▼
                       Phase 6 (MVP-1: v12 write, test env)
                                   │
                     ┄┄┄┄┄┄┄┄┄ external gate: PTV ships v12 write, prod ┄┄┄┄┄┄┄┄┄┄┄┄
                                   ▼
                       Phase 7 (MVP-2: v12 write, production
                                + migrate off and remove Track 3B)
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

## Phase 1: Data layer, PTV v12 client, and v11 discovery
**Mode:** Parallel (3 streams)
**Depends on:** Phase 0
**Goal:** Migrations run clean on a fresh DB; the app can call a real PTV
v12 search endpoint and get typed, validated data back; we know whether v11
write support is worth building and what shape it needs.

**Stream A — Data layer**
- Schema + migrations: `User`, `Tenant`, `Membership`, `TenantEnvironment`, `PtvApiCapabilities`, `AuditEntry`
- `TenantEnvironment` stores credentials as a **polymorphic encrypted blob**
  (JSON, shape keyed by `api_version`) rather than a single
  `encrypted_api_key` string — so v11's credential shape (likely
  username+password "API user", to be confirmed by Stream C) never forces
  a schema migration, and removing v11 later is a data cleanup, not a
  schema change
- Row-Level Security policies keyed on `tenant_id`
- Seed script for local dev (fake tenants/users)

**Stream B — PTV v12 client foundation**
- Vendor PTV v12 `openapi.json`, generate TS types (`openapi-typescript`) + Ajv validators from it
- Typed HTTP client: retry/backoff+jitter, auth adapter interface (`x-api-key` now, `bearerAuth`-ready)
- Capability-gate stub (reads `PtvApiCapabilities` shape, hardcoded config until Stream A's table lands)

**Stream C — v11 write-path discovery (spike)**
- Obtain v11's API documentation/spec; confirm its actual auth model —
  don't assume it matches v12's simple API key
- Confirm v11's write request/response shapes well enough to gauge how far
  they diverge from the v12 beta Post/Put schemas already reviewed
- **Go/no-go decision**, reported back into Stream A before its schema is
  finalized: is v11 support worth building, or does MVP-0's manual export
  cover the gap acceptably until 04/2027?

**Sync point:** `npm run db:migrate` succeeds on a fresh Postgres; a script
calls the v12 search equivalent against the real test environment and
returns validated, typed results; Stream C's go/no-go is documented and
Stream A's credential schema reflects it.

---

## Phase 2: Core platform services
**Mode:** Parallel (4 streams)
**Depends on:** Phase 1
**Goal:** An authenticated request can resolve tenant + role, decrypt the
right PTV credentials for the right API version, and every action is
recorded.

**Stream A — Auth**
- JWT issue/verify, Argon2id hashing, refresh-token rotation + denylist
- Register / login / verify-email / reset-password / logout routes
- RBAC middleware for Reader / Editor / Publisher / Tenant Admin

**Stream B — Tenant & credential management**
- Tenant/membership CRUD
- Envelope-encrypted credential storage (per-tenant data key wrapped by
  environment master key), handling both v12's API-key shape and (if
  Phase 1C said go) v11's shape, write-only-after-save UI contract
- `PtvApiCapabilities` wired to real DB table

**Stream C — Audit logging**
- Append-only audit-entry write path, correlation IDs, `ptv_api_version`/`environment` fields
- Retention + access-restriction policy for `prompt`/`before_state`/`after_state` (GDPR)

**Stream D — PTV client integration finish**
- Wire capability gate to live `PtvApiCapabilities`
- Liveness/readiness polling per tenant/environment
- `archived` endpoint sync helper for incremental cache invalidation

**Sync point:** integration test — log in, resolve tenant + role, decrypt
the tenant's real API credentials, and successfully call PTV; audit entry
recorded for the call.

---

## Phase 3: MCP tool layer
**Mode:** Parallel (4 streams)
**Depends on:** Phase 2
**Goal:** An agent can search PTV content, propose a change, validate it,
and produce a manual-publish export — fully audited.

**Stream A — Search tools**
`ptv_search_services`, `ptv_get_service`, `ptv_search_channels`, `ptv_get_channel`, `ptv_get_organisation` (+hierarchy), `ptv_search_service_collections`, `ptv_search_general_descriptions`, `ptv_search_connections`, `ptv_list_codes`

**Stream B — Propose-changes / diff engine**
`ptv_propose_changes` — current-state fetch + AI-proposed delta + structured diff, no writes. **Freeze this JSON contract early** — Phase 4 Stream C builds a UI against it.

**Stream C — Validation engine**
`ptv_validate_changes` — type-aware (3 service subtypes × 5 channel subtypes), generated from PTV's v12 Post/Put schemas, checks controlled-vocabulary membership and cardinality limits

**Stream D — Manual export**
`ptv_export_for_manual_publish` — renders an approved proposal into a PTV-UI-ready, per-language format; writes `ReadyForManualPublish` audit entries

**Sync point:** end-to-end script — search a real service, propose a
rewrite, validate it, export it — with every step in the audit log.

---

## Phase 4: Web UI
**Mode:** Parallel (3 streams)
**Depends on:** Phase 2 (runs alongside Phase 3, not behind it)
**Goal:** Tenant admins can self-serve users, keys, and audit visibility
without touching the DB.

**Stream A — Auth & tenant/user management UI** (login, org switcher, membership/role editing)
**Stream B — Credential management UI** (masked display, replace-only flow, per-environment, per-`api_version` once Track 3B exists)
**Stream C — Audit log viewer / proposal review UI** (diff view depends on Phase 3 Stream B's frozen contract — build against a mock if it isn't ready yet)

**Sync point:** a tenant admin can create a user, set their role, rotate a
credential, and see it in the audit log, all from the UI.

---

## Track 3B: v11 write adapter (parallel, off the critical path)
**Mode:** Sequential internally; runs alongside Phases 3–4
**Depends on:** Phase 2, and a "go" from Phase 1 Stream C
**Goal:** Publisher role can write to PTV **production now**, without
waiting for v12's write API (not due until 04/2027).

1. Implement a `Ptv11Client` behind the same interface as the v12 client (retry/backoff, capability gate, audit hooks all reused)
2. Add `PtvApiCapabilities` rows for `api_version = v11`, `environment = production`, `supports_write` feature-flagged off by default
3. Route `ptv_apply_changes` through whichever adapter the tenant's capabilities row points to
4. Validate against v11's actual schemas from the Phase 1C spike — don't assume the v12 validation code applies unmodified
5. Pilot on one tenant/environment, confirm, then flip the flag more broadly

Skip this track entirely if Phase 1C's discovery comes back "not worth it"
— MVP-0's manual export remains the production path until Phase 7.

---

## Phase 5: Integration hardening & MVP-0 launch
**Mode:** Sequential
**Depends on:** Phase 3, Phase 4
**Goal:** Deployable, reviewed, documented MVP-0.

1. End-to-end tests across the full propose → validate → export flow, per role
2. Multi-tenant isolation tests (attempt cross-tenant reads/writes, confirm RLS actually blocks them, not just that policies exist)
3. Security review (secrets handling, key rotation, GDPR retention on audit fields) — include Track 3B's credential handling if it has shipped by this point
4. Docs: deployment guide, capability-matrix explainer, README
5. Production Docker/Compose config finalized, CI/CD deploy step added

**This is the MVP-0 ship gate.** Track 3B may ship before or after this
gate independently — it isn't a dependency in either direction.

---

## Phase 6: MVP-1 — write to PTV v12 test environment
**Mode:** Sequential
**Depends on:** Phase 5 **and** PTV publishing v12 write endpoints to its test environment (external, expected ~10/2026)
**Goal:** `ptv_apply_changes` works against PTV's v12 test environment.

1. Re-generate types/validators once PTV's write OpenAPI schemas are final (they're beta today)
2. Implement the v12 write path against POST/PUT endpoints, test env only
3. Flip `PtvApiCapabilities.supports_write = true` for `api_version = v12`, `environment = test`
4. Enable Publisher role's write path, add idempotency handling for POST (dedup key), retry-safety for PUT
5. Write-path audit entries (`ApplyServiceChange`, before/after PTV state)

---

## Phase 7: MVP-2 — write to PTV v12 production, retire v11
**Mode:** Sequential
**Depends on:** Phase 6 **and** PTV publishing v12 write endpoints to production (external, expected ~04/2027)
**Goal:** `ptv_apply_changes` works in production on v12; Track 3B is fully decommissioned.

1. Flip `PtvApiCapabilities.supports_write = true` for `api_version = v12`, `environment = production`
2. Final security review specific to production writes
3. If Track 3B shipped: run the v11 and v12-production adapters side by side for a transition window — don't cut over on day one
4. Migrate tenants off v11 credentials/config one at a time, confirming each on v12 before moving to the next
5. Delete `Ptv11Client`, drop v11-specific `PtvApiCapabilities` rows, remove the now-unused branch of the polymorphic credential handling
6. Update docs to remove v11 references

---

## Critical Path
Phase 0 → Phase 1 (Stream A) → Phase 2 → Phase 3 → Phase 5 → *(external
wait)* → Phase 6 → *(external wait)* → Phase 7

Phase 1 Stream B, Phase 1 Stream C, Phase 4, and Track 3B all hang off this
spine but never lengthen it if resourced properly — they're the first
things to cut or defer if the internal timeline needs compressing.

## Risk Register
- **PTV's v12 write-schema beta churn** — the Post/Put schemas used in Phase 1B/3C are still beta; a shape change before Phase 6 requires re-generating types. Mitigation: pin the OpenAPI JSON version, diff on every re-fetch.
- **RLS false confidence** — RLS policies wrongly scoped (e.g., missing on a join table) silently reintroduce the cross-tenant leak they're meant to prevent. Mitigation: the isolation tests in Phase 5 must attempt real cross-tenant access, not just check policy existence.
- **Phase 4 Stream C / Phase 3 Stream B contract drift** — UI diff viewer built against a guessed shape before the diff engine is final. Mitigation: freeze the diff JSON contract at the start of Phase 3/4, not at their sync point.
- **External-gate slippage** — PTV's 10/2026 and 04/2027 dates are the vendor's own projected roadmap, not commitments. Mitigation: keep Phase 6/7 fully spec'd but don't staff them until PTV's test/prod environments actually expose the endpoints — check via a scheduled probe against the live OpenAPI JSON rather than trusting the calendar.
- **v11 unknown territory (Track 3B)** — v11's auth model and write shapes are unverified as of this writing. Mitigation: Phase 1C is a hard go/no-go gate before any adapter code is written; if discovery reveals a heavy onboarding process (e.g., per-organization manual approval) or a data model that diverges sharply from v12, drop the track rather than force it.
- **v11/v12 cutover risk (Phase 7)** — removing v11 before every tenant is confirmed working on v12 production risks breaking live publishing for whoever's still on it. Mitigation: the side-by-side transition window and per-tenant migration in Phase 7 steps 3–4 are not optional, even under schedule pressure.

## Recommended Starting Point
Phase 0, step 1 — the ESM/TypeScript scaffold gates literally everything
else. Kick off Phase 1's three streams the moment Phase 0's Docker Compose
and app skeleton are up, including the v11 discovery spike (Stream C) —
it's pure research with no code dependencies, so there's no reason to
delay it, and its answer shapes Stream A's schema decisions.

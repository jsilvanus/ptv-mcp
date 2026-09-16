# PTV MCP Server — Execution Plan

> Live checklist for implementation. The authoritative design rationale
> lives in [`docs/plan.md`](./docs/plan.md), [`docs/phase-plan.md`](./docs/phase-plan.md),
> and [`docs/ptv-v11-notes.md`](./docs/ptv-v11-notes.md) — this file tracks
> execution progress only. See `EXECUTION_LOG.md` for the append-only
> audit trail (owned files per phase, sync point verification, deviations).
>
> Phases 7 (MVP-1) and 8 (MVP-2) are gated on PTV's own external roadmap
> (v12 write API in test ~10/2026, production ~04/2027) and are not
> started — they're listed here for continuity only.

## Phase 0: Foundation ✅ 🔒
- [x] Initialize Node.js ESM/TypeScript project (`"type": "module"`, `moduleResolution: NodeNext`), lint/format/test tooling
- [x] Docker Compose: Postgres + app container skeleton
- [x] Fastify app skeleton with `/health` route
- [x] Env/config loader (per-environment secrets, master-key placeholder)
- [x] CI pipeline skeleton (lint + test on push)

## Phase 1: Data layer, adapter contract, and domain model ✅ 🔒
**Stream A — Data layer** ✅ 🔒
- [x] Schema + migrations: `User`, `Tenant`, `Membership`, `TenantEnvironment`, `PtvAdapterConfig`, `UserPtvConnection`, `AuditEntry`
- [x] `TenantEnvironment` polymorphic encrypted credential blob (tenant-scoped, e.g. v12's API key)
- [x] `UserPtvConnection` (user-scoped, e.g. v11's OAuth token) keyed by `(user_id, api_version, environment)`
- [x] `PtvAdapterConfig` keyed by `(tenant_id, environment, api_version)` with `credential_scope`
- [x] Row-Level Security policies keyed on `tenant_id`; `UserPtvConnection` restricted to owning user
- [x] Seed script for local dev

**Stream B — `PtvAdapter` contract and domain model** ✅ 🔒
- [x] Define `PtvAdapter` TypeScript interface
- [x] Define shared domain model (Service ×3 subtypes, ServiceChannel ×5 subtypes, Organization, GeneralDescription, ServiceCollection, Connection, code lists)
- [x] Define `PtvAdapterRegistry` resolution contract `(tenant, environment, operation, actingUser)`
- [x] Contract test suite stub (fixture-driven, runs against a fake in-memory adapter)

## Phase 2: Adapter implementations — v11 and v12, side by side ⏸
**Stream 2A — `PtvV12Adapter`**
- [ ] Vendor v12 `openapi.json`, generate wire types + Ajv validators
- [ ] Read methods against domain model
- [ ] `x-api-key` auth, retry/backoff+jitter
- [ ] Write methods stubbed (`supports_write: false` until Phase 7)

**Stream 2B — `PtvV11Adapter`**
- [ ] Vendor v11 `swagger.json`, generate wire types
- [ ] Read methods (published + restricted draft-visibility endpoints)
- [ ] Embedded-connection extraction
- [ ] Per-user consent flow: auth link, fragment-capturing callback, introspection validation
- [ ] Delete-flag mapping table for PUT partial updates
- [ ] Wire `PtvAdapterConfig` for v11 (`credential_scope = user`, `supports_write = true` for production)

## Phase 3: Core platform services ⏸
- [ ] Stream A — Auth (JWT, Argon2id, refresh rotation + denylist, RBAC)
- [ ] Stream B — Tenant & credential management (`TenantEnvironment` + `UserPtvConnection`)
- [ ] Stream C — Audit logging
- [ ] Stream D — Adapter registry implementation

## Phase 4: MCP tool layer ⏸
- [ ] Stream A — Search tools
- [ ] Stream B — Propose-changes / diff engine
- [ ] Stream C — Validation engine
- [ ] Stream D — Apply / export (`ptv_export_for_manual_publish`, `ptv_apply_changes`)

## Phase 5: Web UI ⏸
- [ ] Stream A — Auth & tenant/user management UI
- [ ] Stream B — Credential management UI (tenant admin screen + personal "connect PTV" screen)
- [ ] Stream C — Audit log viewer / proposal review UI

## Phase 6: Integration hardening & MVP-0 launch ⏸
- [ ] End-to-end tests, per role, against both adapters
- [ ] Multi-tenant isolation tests (incl. same-user-different-tenant reuse test)
- [ ] Security review
- [ ] Docs: deployment guide, adapter runbook
- [ ] Production Docker/Compose + CI/CD
- [ ] Staged `PtvV11Adapter` write rollout

## Phase 7: MVP-1 — `PtvV12Adapter` write, test env — NOT STARTED (external gate)
## Phase 8: MVP-2 — `PtvV12Adapter` write, production; retire `PtvV11Adapter` — NOT STARTED (external gate)

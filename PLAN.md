# PTV MCP Server — Execution Plan

> Live checklist for implementation. The authoritative design rationale
> lives in [`docs/plan.md`](./docs/plan.md), [`docs/phase-plan.md`](./docs/phase-plan.md),
> and [`docs/ptv-v11-notes.md`](./docs/ptv-v11-notes.md) — this file tracks
> execution progress only. See `EXECUTION_LOG.md` for the append-only
> audit trail (owned files per phase, sync point verification, deviations).
>
> **Resequenced 2026-09-16**: `PtvV11Adapter` and `PtvV12Adapter` are no
> longer built side by side. MVP-0 (Phases 0–6) ships on `PtvV11Adapter`
> alone; `PtvV12Adapter` becomes its own phase (7) started only after
> MVP-0 is live. Phases 8 (MVP-1) and 9 (MVP-2) are gated on PTV's own
> external roadmap (v12 write API in test ~10/2026, production ~04/2027).
> See `docs/phase-plan.md` for the full rationale.

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

## Phase 2: `PtvV11Adapter` implementation ✅ 🔒
- [x] Vendor v11 `swagger.json`, generate wire types
- [x] Read methods (published content — draft-visibility `/active` endpoints not yet wired, tracked as a gap)
- [x] Embedded-connection extraction
- [x] Per-user consent flow: auth link, fragment-capturing callback, introspection validation (unit-tested against mocks; live end-to-end untested — needs a registered PTV OAuth client, an external prerequisite)
- [x] Delete-flag mapping table for PUT partial updates
- [x] `applyServiceChange` against v11's PUT endpoint (unit-tested; not exercised live — needs a real access token)
- [ ] Wire `PtvAdapterConfig` for v11 (`credential_scope = user`, `supports_write = true` for production) — deferred to Phase 3, where the registry first reads this table

## Phase 3: Core platform services ✅ 🔒
- [x] Stream A — Auth (JWT, Argon2id, refresh rotation + denylist, RBAC) ✅
- [x] Stream B — Tenant & credential management (`UserPtvConnection` for v11; `TenantEnvironment` storage exercised by tests only, no UI yet) ✅
- [x] Stream C — Audit logging ✅
- [x] Stream D — Adapter registry implementation (verify both credential-scope branches using the Phase 1 in-memory fake) ✅

## Phase 4: MCP tool layer ✅ 🔒
- [x] Stream A — Search tools ✅
- [x] Stream B — Propose-changes / diff engine ✅
- [x] Stream C — Validation engine ✅
- [x] Stream D — Apply / export (`ptv_export_for_manual_publish`, `ptv_apply_changes`) ✅
- [x] MCP server wiring (real `@modelcontextprotocol/sdk`, stateless Streamable HTTP transport on Fastify) ✅

## Phase 5: Web UI ✅ 🔒
- [x] Stream A — Auth & tenant/user management UI (Vite + React + TS SPA in `web/`; login/register, tenant list/create, member management with role editing) ✅
- [x] Stream B — Credential management UI: personal "connect PTV" screen only (v11); tenant-admin API-key screen deferred to Phase 7 ✅
- [x] Stream C — Audit log viewer / proposal review UI (filterable by resource type / correlation id, expandable diff view) ✅

## Phase 6: Integration hardening & MVP-0 launch ✅
- [x] End-to-end tests, per role (v11 only)
- [x] Multi-tenant isolation tests (incl. same-user-different-tenant reuse test)
- [x] Security review
- [x] Docs: deployment guide, **adapter onboarding runbook** (formalized from Phase 2, to be run again in Phase 7)
- [x] Production Docker/Compose + CI/CD
- [x] Staged `PtvV11Adapter` write rollout
- [x] **MVP-0 SHIPS — v11-only**

## Phase 7: `PtvV12Adapter` implementation (post-MVP-0) ⏸
- [ ] Vendor v12 `openapi.json`, generate wire types + Ajv validators
- [ ] Read methods against domain model
- [ ] `x-api-key` auth (tenant-scoped), retry/backoff+jitter
- [ ] Write methods implemented against beta schemas, gated off (`supports_write: false`)
- [ ] Tenant-admin API-key management UI (`TenantEnvironment`), deferred from Phase 5
- [ ] Contract test suite run against `PtvV12Adapter`
- [ ] Pilot tenant confirms real v12 search via the existing MCP tools, unchanged

## Phase 8: MVP-1 — `PtvV12Adapter` write, test env — NOT STARTED (external gate)
## Phase 9: MVP-2 — `PtvV12Adapter` write, production; retire `PtvV11Adapter` — NOT STARTED (external gate)

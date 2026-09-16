# PTV v11 API – findings for read and write support

> Source: `https://api.palvelutietovaranto.suomi.fi/swagger/v11/swagger.json`
> (OpenAPI 3.0.4, 88 operations, 126 schemas), fetched and reviewed
> 2026-09-16. This document feeds Track 3B ("v11 write adapter") and
> Phase 1C ("v11 discovery spike") in [`docs/phase-plan.md`](./phase-plan.md).
> It supersedes the speculative auth guesses in `docs/plan.md`'s original
> v11 section — those were wrong on the specifics, right that v12 and v11
> would differ.

## Headline answer: is v11 read similar to v12 read?

**Same content domains, different API shape, and one major divergence:
v11's ordinary reads require no credentials at all, whereas v12 requires
an API key for every call, read included.**

| | v12 | v11 |
|---|---|---|
| Read shape | One `search` endpoint per content type + query-param filters (area, org, service type, ...) + pagination (`page`, `pageSize`) | Many purpose-built endpoints per content type (`by area/code`, `by industrial class`, `by service class`, `by target group`, `by organization`, `by business code`, `by oid`, `list` by GUID batch, ...); pagination is just `page`, page size is server-fixed |
| Auth on ordinary reads | **Required** (`x-api-key` on every call, per its docs) | **None** — most GET endpoints have no `security` requirement at all |
| Auth on writes / draft data | N/A (no write endpoints exist yet) | **OAuth2** required (see below) |
| Draft/unpublished content | Not exposed — v12 today only returns published + archived | Exposed via explicitly **"restricted"** endpoints (`Service/active`, `ServiceChannel/active`, `Common/Translation`, `Common/NotMaintainedServices`, etc.), all requiring OAuth2 |
| Connections (service↔channel) | Dedicated `GET /connection/{ids}`, `/connection/search`, `/connection/archived` | **No GET endpoint exists.** Connections are only visible embedded inside a `Service`/`ServiceChannel` response (`serviceChannels`/`organizations` fields) or written via `POST`/`PUT /Connection*` |
| Content types covered | Service (3 subtypes), Service channel (5 subtypes), Organization, General description, Service collection, Connection, code lists | Same content types, same 5 channel subtypes (`EChannel`, `Phone`, `PrintableForm`, `ServiceLocation`, `WebPage`) and worded the same 3 service types (`Service`, `PermitOrObligation`, `ProfessionalQualification`) — the data model really is compatible across versions, as PTV's migration page claimed |
| Publishing status | Not modeled in the API (only published/archived split via separate endpoints) | **Explicit `publishingStatus` field** (`Published`/`Draft`/`Archived`/`Withdrawn` per the `status` query param and `/active` endpoints) |

**Practical conclusion:** if all you need is "search and read published PTV
content," v11 and v12 are functionally equivalent in coverage — build
against v12, it's the future and doesn't need OAuth. **v11 read only earns
its place if you specifically need draft/unpublished visibility** (e.g., to
show what's already sitting in PTV as a draft before your own proposal
flow touches it) or you're building the write adapter anyway and want to
verify a write against v11's own view of the entity.

## Auth model — the real divergence, with a caveat

v11 declares a single security scheme:

```json
"oauth2": {
  "type": "oauth2",
  "flows": {
    "implicit": {
      "authorizationUrl": "https://palveluhallinta.suomi.fi/api/auth/connect/authorize",
      "scopes": { "dataEventRecords": "Access event records" }
    }
  }
}
```

Applied per-operation: **all POST/PUT (write) operations and all
"restricted" GET operations require it; ordinary GET operations have no
`security` block at all** (confirmed by inspecting `security` on
`POST /Service`, `GET /Common/Translation` — both `[{"oauth2": []}]` — vs.
`GET /Service/{id}` — `None`).

**Caveat worth flagging before building anything on this:** the scope name
`dataEventRecords` is the literal example scope name from IdentityServer4's
official quickstart documentation. That strongly suggests PTV's Swagger
config was adapted from an IdentityServer/Duende sample without
customizing it, which means:

- The declared flow (`implicit`) may not reflect what's actually usable
  for a **server-to-server** integration. Implicit grant is a
  browser/front-channel flow with no refresh token and short-lived
  access tokens — workable for a human clicking through PTV's own admin
  UI, awkward for an unattended backend service.
- Real-world PTV integrators (municipalities, existing vendors) almost
  certainly use a different practical mechanism — possibly
  `client_credentials`, possibly a registered client with a long-lived
  secret issued through `palveluhallinta.suomi.fi`'s own onboarding, not
  literally the browser implicit flow as declared.

**This is exactly what Phase 1C's discovery spike needs to resolve before
Track 3B writes any code**: register (or find documentation for) an actual
API client in `palveluhallinta.suomi.fi`, and determine the real grant
type and token lifetime in practice, rather than trusting the Swagger
document's `implicit` declaration at face value.

## Write model — key structural findings

1. **Type-specific endpoints, matching v12's beta split.** Channels: `POST
   /ServiceChannel/{EChannel|Phone|PrintableForm|ServiceLocation|WebPage}`.
   Services: one `POST /Service` (subtype selected by a `type` field in the
   body: `Service`, `PermitOrObligation`, `ProfessionalQualification`).
   Confirms the same content model as v12's beta `Post*Request`/`Put*Request`
   schemas — a validation ruleset built for one should translate to the other
   with field-name changes rather than a redesign.

2. **Dual addressing for updates.** Every updatable entity has two PUT
   routes: by PTV's own id (`PUT /Service/{id}`) and by **your own external
   `sourceId`** (`PUT /Service/sourceId/{sourceId}`). The same pattern
   exists for connections (`POST /Connection/Source`,
   `PUT /Connection/serviceSourceId/{serviceSourceId}`). Useful if we ever
   want our own DB's primary key to double as the PTV-side reference and
   skip a lookup — but likely simpler for MVP to always resolve and use
   PTV's `id`, since we already fetch the entity to build the diff.

3. **PUT is a partial update with explicit "clear" flags, not a full
   replace.** The service write model
   (`V9VmOpenApiServiceIn` — note it's internally still versioned "V9"
   even inside the v11 spec) includes flags like `deleteAllServiceVouchers`,
   `deleteAllLifeEvents`, `deleteAllIndustrialClasses`,
   `deleteAllMunicipalities`, `deleteAllLaws`, `deleteServiceChargeType`,
   `deleteGeneralDescriptionId`. Omitting a field does **not** clear it —
   you must set the matching `deleteX` flag to remove a value. **This is a
   real correctness trap**: `ptv_apply_changes`'s diff-to-request mapping
   must translate "field removed in the proposal" into the right
   `deleteX: true` flag, or a user-approved removal will silently no-op
   against PTV. (v12's beta `Put*Request` schemas didn't show this pattern
   in the fields reviewed so far — worth re-checking once v12's write
   schemas are finalized, since the two versions may differ here.)

4. **Explicit `publishingStatus` on write**, plus a **`userName` field** on
   the service write model — PTV wants to know which individual made the
   change, not just which API client. Map this to the acting user's stable
   identifier (not their email, to avoid needlessly pushing PII into PTV) —
   this also gives a natural cross-reference key between our own audit log
   and PTV's own change history, worth keeping even after v11 is retired.

5. **No read-back for connections** (see table above) — the write adapter
   must derive "current connections" for a diff by reading the `Service`/
   `ServiceChannel` payload's embedded `serviceChannels`/`organizations`
   fields, not a dedicated endpoint.

6. **ASTI-specific endpoints** (`PUT /Connection/ASTI/...`) are restricted
   to a specific national register's integrators and are **out of scope** —
   don't build against them.

## Revised scope for Track 3B

Given the above, Track 3B's discovery step (Phase 1C) should produce three
concrete answers, not just a go/no-go:

1. **Real grant type** for OAuth2 against `palveluhallinta.suomi.fi` (see
   caveat above) — this decides whether Track 3B is even operable
   unattended.
2. **Whether v11 read is needed at all**, beyond what v12 already covers —
   likely yes, narrowly, for the "restricted" draft-visibility endpoints
   (`Service/active/{id}`, `ServiceChannel/active/{id}`) so a proposal can
   be diffed against a draft that already exists in PTV, not just against
   the last published version.
3. **Delete-flag mapping table** for each writable entity type, built
   before any `ptv_apply_changes` v11 code is written, so approved
   deletions aren't silently swallowed.

If (1) comes back as "genuinely browser-only, no viable unattended grant,"
Track 3B should be dropped — an OAuth flow that requires a human to
re-authenticate periodically doesn't fit an autonomous MCP write path, and
MVP-0's manual-export flow remains the right production path until v12
write ships.

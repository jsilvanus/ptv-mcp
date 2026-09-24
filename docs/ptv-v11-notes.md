# PTV v11 API – findings for read and write support

> Source: `https://api.palvelutietovaranto.suomi.fi/swagger/v11/swagger.json`
> (OpenAPI 3.0.4, 88 operations, 126 schemas) and the live OIDC discovery
> document at `palveluhallinta.suomi.fi`, fetched and reviewed 2026-09-16.
> This document feeds `PtvV11Adapter`'s design in
> [`docs/phase-plan.md`](./phase-plan.md) (Phase 2B). It supersedes the
> speculative auth guesses in `docs/plan.md`'s original v11 section — those
> were wrong on the specifics, right that v12 and v11 would differ. The
> OAuth grant-type question flagged in the first pass of this document is
> now resolved (see "Auth model" below): it's confirmed, not merely
> suspected, that the implicit grant is the *only* mechanism, and that the
> resulting credential is personal to a user, not scoped to a tenant.

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

## Update 2026-09-24: IN-API writes use an organisation API user, not per-user OAuth

> **This supersedes the "Auth model" conclusions below for writes.**
> DVV's own IN-integration documentation
> ([Lisätietoa IN-integraation toteuttajalle](https://kehittajille.suomi.fi/palvelut/palvelutietovaranto/ptv-tietojen-hyodyntaminen/tekninen-dokumentaatio-integraation-toteuttajalle/lisatietoa-in-integraation-toteuttajalle))
> describes a different mechanism from the implicit grant inferred from the
> swagger and OIDC discovery document. The IN integration is **per
> organisation**: DVV grants an **API user** (username + password) after an
> IN-API permit application, and it is exchanged for a bearer token.
>
> | | Login | Body | Response |
> |---|---|---|---|
> | production | `POST https://palveluhallinta.suomi.fi/api/auth/api-login` | `{username, password, apiUserOrganisation?}` | `{serviceToken}` |
> | test | `POST https://palvelutietovaranto.trn.suomi.fi/connect/token` | `{username, password}` | `{ptvToken}` |
>
> - The credential is **tenant-scoped** (like v12's API key), stored in
>   `TenantEnvironment` and configured by a tenant admin
>   (`/tenants/:tenantId/ptv/v11/api-user`, web UI *PTV connections*).
>   `PtvAdapterConfig` for v11 becomes `credentialScope: 'tenant'`,
>   `authMode: 'api_login'`.
> - `src/ptv/v11/auth/apiLogin.ts` does the login, reads `exp` from the JWT
>   and caches the token per process until 60 s before expiry. Tokens are only
>   sent on POST/PUT; public GETs stay anonymous (see the 500-on-bad-token
>   finding at the end of this file). On a 401 the client logs in once more
>   and retries.
> - `apiUserOrganisation` is needed in production only when one API user is
>   linked to several organisations. A test token is bound to exactly one
>   organisation.
> - The test environment's swagger declares the security scheme as a plain
>   `Authorization: Bearer` apiKey, not the implicit flow production's swagger
>   shows. That matches the API-login mechanism.
> - The per-user implicit-grant path (`auth/oauth.ts`, `/ptv-connections/v11/*`)
>   is kept for now (`credentialScope: 'user'`) but is not DVV's documented
>   IN-integration path. Review whether to retire it once API-user writes
>   are verified.
> - Accountability is unchanged: writes still need a Publisher-approved
>   proposal, and the audit log records the acting user. PTV itself will
>   attribute the write to the API user.
>
> Test environment details and organisation ids:
> [docs/ptv-test-environment.md](ptv-test-environment.md).

## Auth model — confirmed against the live OIDC discovery document

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

The scope name `dataEventRecords` is the literal example scope from
IdentityServer4's quickstart docs, which originally read as a sign this
might be unmodified boilerplate rather than the real mechanism. **That
suspicion is resolved — checked directly, 2026-09-16** against the live
discovery document:

```
GET https://palveluhallinta.suomi.fi/api/auth/.well-known/openid-configuration
```
```json
{
  "issuer": "https://palveluhallinta.suomi.fi",
  "jwks_uri": "",
  "token_endpoint": "",
  "userinfo_endpoint": "",
  "introspection_endpoint": "https://palveluhallinta.suomi.fi/api/auth/introspect",
  "revocation_endpoint": "https://palveluhallinta.suomi.fi/api/auth/revoke"
}
```

**`token_endpoint` is empty.** That's decisive: there is no
`client_credentials` or `authorization_code`+refresh path hiding behind
the declared flow — no token endpoint exists at all, so no other grant
type is possible. The implicit grant, with the access token returned
directly on the browser redirect, **is genuinely the only door in**. This
isn't leftover boilerplate; it's a deliberately narrow configuration. Two
consequences, now confirmed rather than hypothesized:

1. **No refresh token can ever exist here** (not just "implicit grant
   doesn't issue one" — there's no token endpoint to refresh against even
   in principle). A v11 write credential has to be periodically
   re-obtained by a human, full stop.
2. **The credential is personal, not organizational.** The token comes
   from a human logging into `palveluhallinta.suomi.fi` with their own PTV
   account — there is no service-account or client-credentials path for a
   backend to authenticate as "the organization." Whatever PTV
   organizations that person is authorized for on PTV's own side is what
   the resulting token can write to. This lines up with the `userName`
   field on v11's write schema ([see below](#write-model--key-structural-findings)) — PTV expects
   writes attributed to a named individual, not an anonymous API client.

### What this means for the integration: a link, not a client secret

Because there's no server-to-server option, `PtvV11Adapter`'s write path
is built as a **per-user consent flow**, not a background credential:

1. The user (whoever holds Publisher role and has their own PTV login) is
   shown an authorization link:
   `authorizationUrl` + our registered `client_id` + our `redirect_uri`.
2. They click it, log into `palveluhallinta.suomi.fi` with their personal
   PTV credentials, and are redirected back with the token in the **URL
   fragment** (`#access_token=...`) — implicit grant never sends it to the
   server directly, so the redirect target needs a small page that reads
   `location.hash` client-side and POSTs it to our backend.
3. The backend validates the captured token against the **introspection
   endpoint** (`/api/auth/introspect`) before trusting it, and can later
   use the **revocation endpoint** (`/api/auth/revoke`) if the user
   disconnects their PTV account from our system.
4. When the stored token has expired (no refresh possible), the apply-step
   UI shows "reconnect to PTV" instead of failing silently. This costs
   nothing extra in practice: `ptv_apply_changes` already requires a human
   Publisher to approve before anything is written, so there's always
   someone present at exactly the moment a fresh token would be needed —
   this was never going to be a fully unattended background write path,
   and the two-phase approval design already assumed that.

### Do we still need `tenant_id` here, if the credential is personal?

**Yes for authorization and audit — no for the credential itself.**
`PtvV11Adapter`'s credential is best modeled as `(user_id, environment)`,
completely decoupled from `tenant_id`: a person who is a Publisher for two
different tenants in our system connects their PTV account **once**, and
the same token is reusable for both, because PTV — not our tenant model —
decides which organizations that person can write to. Forcing a separate
"connect PTV" per tenant would just mean logging into the same PTV account
twice for no reason.

What still needs `tenant_id`, independent of where the credential lives:

- **Authorization**: we check the acting user holds Publisher role *for
  this tenant* before ever looking up their PTV connection — that gate is
  entirely ours and doesn't move.
- **Audit**: the log entry records `tenant_id` (which church's data was
  touched) and `user_id` (whose PTV identity performed the write) side by
  side — the write attribution PTV wants via `userName` and the tenant
  attribution our audit model wants are the same underlying fact, just
  logged for two different reasons.
- **A safety net, not a substitute**: if the user's PTV-side access
  doesn't actually cover this tenant's organization, PTV's own write call
  rejects it — a useful backstop, but our own tenant/role check always
  runs first and is what we actually rely on.

This also means **credential scope is adapter-defined, not uniform**:
v12's credential (a static API key) is naturally organization/tenant-scoped
— one tenant admin enters one key for the whole organization. v11's
credential is naturally user-scoped. `PtvAdapter`'s credential-resolution
contract needs to express this explicitly (e.g. a
`credentialScope: 'tenant' | 'user'` on the adapter's capabilities) rather
than assuming every adapter's secret lives on the same tenant-keyed row.

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

## Scope for `PtvV11Adapter`'s write support

The grant-type question is now settled (confirmed against the live OIDC
discovery document, see above) — it's a per-user consent link, not a
background credential, and that fits the product's existing
human-approves-every-write design rather than fighting it. What's left to
build, not merely discover:

1. **The consent-link + callback flow**: authorization link generation,
   the fragment-capturing callback page, token storage keyed by
   `(user_id, environment)`, introspection-based validation, and the
   "reconnect to PTV" UI path for an expired token at the apply step.
2. **Whether v11 read is needed at all**, beyond what v12 already covers —
   likely yes, narrowly, for the "restricted" draft-visibility endpoints
   (`Service/active/{id}`, `ServiceChannel/active/{id}`) so a proposal can
   be diffed against a draft that already exists in PTV, not just against
   the last published version. These restricted reads need the same
   per-user token as writes do.
3. **Delete-flag mapping table** for each writable entity type, built
   before any `ptv_apply_changes` v11 code is written, so approved
   deletions aren't silently swallowed.
4. **Per-tenant authorization stays separate from the credential**: verify
   the acting user's Publisher role for the target tenant before resolving
   their PTV connection — the connection itself carries no tenant context
   of its own (see "Do we still need `tenant_id`" above).

None of this is a go/no-go gate anymore — the mechanism is confirmed
workable, just personal rather than organizational. The only real
per-tenant fallback path that remains is: a user with no PTV connection of
their own (or an expired one, mid-approval) still has MVP-0's manual
export available as an immediate alternative.

## New finding (Phase 3): a malformed Bearer token 500s an otherwise-unauthenticated GET

Confirmed live, 2026-09-16, while building Phase 3's registry sync-point
test: sending a syntactically-invalid `Authorization: Bearer <garbage>`
header on `GET /api/v11/Service` — an endpoint with `security: None`, no
auth required at all per the table above — gets **HTTP 500**, not a plain
200 (ignoring the header) or a 401 (rejecting only the auth attempt).
Practical consequence for `PtvAdapterRegistry` (Phase 3 Stream D): a
credential that's present-but-garbage (e.g. a test fixture, or a real
token that's been corrupted rather than cleanly expired) can break a
*read* call that would otherwise have succeeded unauthenticated. This is
a second instance of the same lesson as the all-zero-GUID 500 found in
Phase 2 — v11 returns 500 for certain classes of malformed input where a
4xx would be more conventional — so any adapter code attaching a
possibly-invalid token to a normally-unauthenticated call should not
assume a 500 always means "PTV is down."

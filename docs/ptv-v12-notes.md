# PTV v12 API – implementation findings

> Unlike [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md), which was written
> from a fresh review of v11's live `swagger.json` and OIDC discovery
> document, this note is written **from the current `PtvV12Adapter`
> implementation** (`src/ptv/v12/adapter.ts`, `src/ptv/v12/client.ts`),
> reviewed 2026-09-20 — there is no vendored `docs/v12-openapi.json` in
> this repo yet and this review had no live network access to PTV's API
> to independently verify wire shapes. Treat the "what the wire shape
> looks like" sections as *what the adapter's defensive mapping code
> currently assumes*, not as an independently confirmed spec. Fixing
> `docs/phase-plan.md` Phase 9 step 1 (vendor the real `openapi.json`,
> generate types) would let this doc be rewritten the way
> `ptv-v11-notes.md` was: from the spec, not from inference.

## Status summary

`PtvV12Adapter` is wired into `DbPtvAdapterRegistry`'s default adapter
factories (`src/ptv/dbAdapterRegistry.ts`) alongside `PtvV11Adapter` —
**both adapters are live in the running system today**, not sequenced as
"v11 now, v12 later" the way `docs/plan.md`'s original phasing describes.
A tenant admin configures a v12 API key per environment through
`web/src/pages/PtvConnectionsPage.tsx` / `src/routes/ptvV12.ts`
(`TenantEnvironment`, tenant-scoped credential). See `PLAN.md`/
`docs/phase-plan.md`'s Phase 9 section for the full checklist state.

**Read coverage is incomplete.** Of the 12 read-side `PtvAdapter` methods:

- Implemented: `searchServices`/`getService`, `searchChannels`/
  `getChannel`, `searchOrganisations`/`getOrganisation`/
  `getOrganisationHierarchy`, `getConnectionsFor`.
- **Unimplemented — throw unconditionally**: `searchServiceCollections`,
  `searchGeneralDescriptions`, `listCodes` (`unsupported()` in
  `adapter.ts`, message `'PTV v12 adapter operation not implemented yet:
  ...'`). A tenant/connection reading via v12 gets a hard MCP tool error
  from `ptv_search_service_collections`, `ptv_search_general_descriptions`,
  and `ptv_list_codes`. `PtvV12Adapter` still satisfies the `PtvAdapter`
  TypeScript interface — the methods exist and type-check — so this gap
  is invisible to `npm run typecheck`/`npm run build` and only surfaces at
  call time or via a contract-test run (not yet done for either real
  adapter — see Phase 9 step 6).

**Write is fully gated off.** `applyServiceChange` is a one-line throw
(`'PTV v12 write operations are not enabled yet'`) — no beta `Post*/Put*`
request-body mapping exists yet to gate, unlike what the original phase
plan described ("implemented against the beta schemas, but gated off").
That mapping work is still fully ahead of whoever picks up Phase
10/MVP-1.

**Search does not use server-side filtering — it downloads the whole
catalogue.** `searchServices`/`searchChannels`/`searchOrganisations` all
go through `fetchAll()`, which loops PTV's `/search` endpoint with
`page`/`pageSize` until PTV reports no more results, fetching **every**
item of that content type regardless of what was actually searched for.
`query` and `organizationId` filtering, and this call's own requested
`page`/`pageSize`, are then applied **in-memory in TypeScript** on the
full result set. `getConnectionsFor` is worse: it calls
`/api/v12/connection/search` exactly once, with no pagination loop at
all — for a tenant/entity with more connections than PTV's default page
size, results are silently truncated with no error. For Finland's
national service catalogue (thousands of services/channels/organisations
across all municipalities and parishes), this means **every v12 search
call, however narrow, pays the cost of a full-catalogue fetch** —
a real scalability problem to fix before production load, not a style
nit. The right fix is server-side query params (`docs/plan.md`'s original
comparison table already asserts v12 supports "area, org, service type,
..." query-param filters on `/search`), but exact param names need the
real OpenAPI spec (step 1's gap) to get right rather than guessed.

## Auth model

`x-api-key` header on every request (`src/ptv/v12/client.ts`), tenant-scoped
via `TenantEnvironment` — matches `docs/ptv-v11-notes.md`'s v11-vs-v12
comparison table (v12 requires an API key on every call, including reads;
v11's ordinary reads need none). Retried with exponential backoff
(`250 * 2^attempt` ms) on `429`/`5xx`, honoring a numeric `Retry-After`
header when present (`retryDelayMs()`); non-retryable failures and
exhausted retries raise `PtvV12ApiError` carrying `status`/`path`.

## Base URLs

```
production: https://api-gw.palvelutietovaranto.suomi.fi
test:       https://api-gw.palvelutietovaranto.trn.suomi.fi
```

(Note the `-gw` and different subdomain structure versus v11's
`api.palvelutietovaranto.suomi.fi` / `...trn.suomi.fi` — these are not
just version-path differences, the gateway host itself differs.)

## Endpoints currently called

```
GET /api/v12/service/search           GET /api/v12/service/{id}
GET /api/v12/service-channel/search   GET /api/v12/service-channel/{id}
GET /api/v12/organization/search      GET /api/v12/organization/{id}
GET /api/v12/connection/search
```

No endpoints are called yet for service collections, general
descriptions, or code lists (the three unimplemented methods above) —
their PTV v12 paths haven't been vendored/confirmed in this codebase.

## Wire shape — localized content

v12 uses `languageVersions`: `{ fi: { name, summary, description }, sv:
{...}, en: {...} }`, a nested per-language object — **not** v11's array of
`{language, value}` records. The adapter's `localized()` helper
(`adapter.ts`) maps this into the shared `LocalizedText` domain shape
(`Partial<Record<LanguageCode, string>>`). A code comment in `adapter.ts`
notes this was a real bug during development: an earlier version of the
mapper treated the nested `languageVersions` objects as non-string values
and silently discarded every localized field — worth remembering if a
future edit to `localized()` regresses this.

## Wire shape — defensive field fallbacks

Every mapper (`mapV12Service`, `mapV12ServiceChannel`,
`mapV12Organization`, `mapV12Connection`) reads multiple possible field
names for the same concept via `??` chains, e.g. `wire.contentId ??
wire.id`, `wire.modifiedAt ?? wire.modified ?? wire.lastModified`,
`wire.organizationId ?? wire.organization?.contentId ?? wire.organization?.id
?? wire.organization?.organizationId`. This defensiveness suggests the
implementer wasn't fully certain of the exact response shape at the
time of writing (consistent with no vendored OpenAPI spec — see the
status summary above) rather than PTV's API genuinely varying field
names response-to-response. Once the real spec is vendored (Phase 9 step
1), these fallback chains should be reconciled against it — some are
probably dead branches, and a real shape mismatch could currently be
silently masked by a fallback that happens to also produce a plausible
(but wrong) value.

## Publishing status / content types

Same domain vocabulary as v11 (`Service` × 3 subtypes conceptually,
`ServiceChannel` × 5 subtypes via `normalizeChannelType()`), consistent
with `docs/ptv-v11-notes.md`'s claim that the v11/v12 data model is
compatible across versions.

## Independent read/write API version selection

Since this adapter went live, `src/mcp/oauthService.ts` and
`src/mcp/toolContext.ts` let a connection select `readApiVersion` and
`writeApiVersion` independently — e.g. a tenant could read via `v12`
(this adapter) while writing via `v11`, since v12 write is fully gated
off. This is not specific to v12 but is the reason v12 reads are reachable
in production today even though v12 write isn't — see
`docs/phase-plan.md`'s Phase 9 write-up for the fuller architecture note.

## Open items for whoever picks up Phase 9/10 next

1. Vendor the real `openapi.json`, generate wire types + validators —
   removes the guessed-fallback-chain risk above and is a prerequisite
   for confidently fixing the full-catalogue-fetch problem with real
   filter param names.
2. Implement `searchServiceCollections`, `searchGeneralDescriptions`,
   `listCodes`, or explicitly mark them unsupported in
   `PtvAdapterCapabilities` so calling code can detect the gap instead of
   hitting a thrown error at call time.
3. Push `query`/`organizationId` filtering and pagination down to PTV's
   `/search` query params instead of the current full-fetch-then-filter
   approach; fix `getConnectionsFor`'s missing pagination loop.
4. Run the Phase 1 contract test suite (`src/ptv/testing/contractTests.ts`)
   against `PtvV12Adapter` — this would have caught the unimplemented-method
   gap immediately.

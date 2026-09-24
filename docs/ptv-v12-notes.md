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

> **Update 2026-09-24:** most of the gaps described below were fixed and
> verified against the live v12 API and the now-vendored spec
> (`docs/ptv-api-documentation.json`). See
> [Live verification and fixes](#live-verification-and-fixes-2026-09-2324)
> at the end of this file before relying on the older sections.

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

### v12 write auth (DVV email, 2026-09-24)

DVV told us by email that v12 writes will use **two credentials**:

- the **API key** (`x-api-key`) identifies the *integration*, as it does for
  reads today;
- a **token** identifies the *user/organisation* doing the write.

v12 write goes to beta in October 2026. Not yet known: how the token is
obtained (the same Palveluhallinta `api-login` as v11's organisation API
user, see `docs/ptv-v11-notes.md`, or something new), its header, and whether
it is per organisation or per person.

Design consequences for the v12 write adapter:

- Keep the API key tenant-scoped in `TenantEnvironment`, as now. Add the
  token source to the same credentials blob (e.g.
  `{apiKey, username, password}`) if it turns out to be an organisation API
  user. `src/ptv/v11/auth/apiLogin.ts`'s token cache (per environment +
  user, JWT `exp`, one shared in-flight login) can then be reused or
  generalised.
- As with v11, send the token only on writes and keep reads on the API key
  alone, unless DVV says reads need it too.
- If the token turns out to be per person, it moves to `UserPtvConnection`
  (`credentialScope: 'user'`) while the API key stays per tenant. The
  registry would then need to resolve both scopes for one adapter; today it
  resolves exactly one.

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
`{language, value}` records. The official migration documentation also shows
this structure in its v12 response example. The adapter's `localized()` helper
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


## Read-parity implementation update

The v12 read implementation now covers the three previously stubbed adapter
operations:

- `GET /api/v12/service-collection/search`
- `GET /api/v12/general-description/search`
- v12 reference-data endpoints for countries, industrial classes, languages,
  life events, municipalities, ontology terms, postal codes, regions, service
  classes, target groups, and wellbeing services counties.

The implementation keeps the stable MCP/domain interface and performs
client-side filtering/pagination for these operations, matching the existing
v12 adapter strategy while the exact server-side filter parameter names remain
an optimization task.

### Important v12 semantic finding: classification names

The v12 migration documentation explicitly says that supplementary and
classification data such as service target groups, life events and keywords
are returned as identifiers only in the search API, rather than as complete
reference-data objects. Therefore a v12 service result containing a
classification ID with an empty `names` object is **not by itself a mapper bug**.
The adapter must not manufacture a localized name from the code. The
reference-data endpoints are the authoritative way to resolve those names.

### Organization reference

The v12 implementation accepts `organizationContentId` as the primary
organization reference, with defensive fallbacks for other beta shapes. This
is separate from the OAuth tenant ID. The repository's v12 implementation plan
already identified `organizationContentId` as a required v12 service field.

### Timestamps

The mapper recognizes several timestamp field variants and normalizes valid
string/numeric timestamps to ISO-8601. If none is present it still uses the
Unix epoch as an explicit "wire field missing" fallback; it does not invent a
real modification time.

### Beta API caveat

The official v12 API documentation is currently version 0.1.0 / OpenAPI 3.1.1
and describes the v12 API as beta. The Suomi.fi transition documentation says
the v12 search API may still change during the transition. The exact
server-side filter parameter names should therefore be verified against the
live Scalar specification before replacing the adapter's client-side filtering
with server-side filters.

## Live verification and fixes (2026-09-23/24)

Every read tool was exercised against the live v12 API (test data:
Riihimäen seurakunta, Tampere associations, Inarin kunta) and checked
against the vendored spec `docs/ptv-api-documentation.json`
(OpenAPI 3.1.1, v12 beta 0.1.0). Fixed in PRs #22–#28:

- **Pagination.** Paginated responses carry `page`, `pageSize`,
  `totalItems`, `totalPages` (`PaginatedType`). The adapter read only
  `totalCount`/`totalElements`/`total`, so every catalogue scan stopped
  after the first 100 items — organisation name search could not find
  most organisations. Pages 2..`totalPages` are now fetched with bounded
  concurrency (6).
- **Server-side filters used where v12 has them:** `organizationContentIds`
  (services, channels, collections, general descriptions),
  `serviceContentIds`/`channelContentIds` (connections, max 20 each),
  `codes`/`uris` (reference data, max 20 each), `name` (ontology terms).
  Organisation name search and free-text search remain client-side:
  v12 has no name/text filter on those `/search` endpoints.
- **Wire field names** confirmed from the spec:
  `parentOrganizationContentId` (hierarchy), `generalDescriptionContentId`,
  `serviceLanguages`, `serviceChannelType` values `EService` /
  `TelephoneService` (→ `EChannel` / `Phone`), service type
  `PermitOrOtherObligation` (→ `PermitOrObligation`), service-collection
  members in `items[]` with `itemType` (only on the detail endpoint, so
  the returned page is hydrated), connection `publishedAt`.
- **`serviceChannelIds`** is filled from `/connection/search`, since v12
  services carry no channel list (matches v11's shape).
- **Classifications.** v12 returns them as a bare code (service classes,
  target groups, life events) or a bare URI (ontology terms, industrial
  classes). Entries are completed from the reference-data endpoints into
  v11's `{code, uri, names}` shape — which the v11 write path needs, since
  a connection may read via v12 and write via v11. Resolved entries live
  in a process-wide in-memory cache (`src/ptv/v12/codeNameCache.ts`):
  30-day TTL, 1 day for codes PTV does not recognise. It is lost on
  restart.
- **Empty translations.** PTV sends `""` for missing translations (e.g.
  MAO-only KOKO concepts have Finnish labels only); these are dropped.
- **Ontology term search** (`ptv_search_ontology_terms`,
  `PtvAdapter.searchOntologyTerms`) uses `/api/v12/ontology-terms?name=`
  with `isValid=true`. Terms are KOKO concepts: KOKO URIs are what PTV
  stores and what v11 writes (`ontologyTerms` = list of KOKO URLs). KOKO
  numbers differ from YSO numbers (e.g. `koko/p32775` "koti" ↔
  `yso/p5473`), so a YSO URI cannot be converted by string replacement.
  v11 has no ontology endpoint and throws
  `OntologySearchUnsupportedError`.

Still open: write support (v12 has no write endpoints in this spec), and
the in-memory code cache could move to Postgres if restart cold-starts
matter.


# ptv-mcp code review

Date: 2026-11-17. Reviewed commit: `8ae24a8` (`main`).

> **Status (2026-11-17):** findings 1 to 5 (high) were fixed in PR #79. Findings 7, 10, 11, 12, 13 and 15 (medium) were fixed afterwards, and 6 partly (service, channel and connection writes fall back to the public read only on 404). Findings 6 (rest), 8, 9 and 14 are open and tracked in [`TODO.md`](../../TODO.md). The text below is the review as written; the "Fix plans" section describes what PR #79 implemented.

## Summary

Five high-severity problems should be fixed before staging users rely on ptv-mcp, and two of them were reproduced with throwaway tests. The worst is that `approve_and_apply` on a proposal that was already rejected or applied still writes to PTV.

Scope: `main` at `8ae24a8`, backend `src/` and migrations, read by hand. The web UI was only checked where it calls the backend. The one open PR (#19, dev port) is from September and was not the target. No code was changed.

Checks run: `npm run typecheck` and `npm run lint` are clean, and all 455 unit tests pass. Integration tests were not run, because this session had no Postgres set up. `npm audit --omit=dev` reports 12 advisories.

| # | Severity | Finding | Status at review | Now |
| --- | --- | --- | --- | --- |
| 1 | High | A resolved proposal can be applied again | Reproduced | Fixed in PR #79 |
| 2 | High | MCP OAuth tokens work as full REST sessions | Reproduced | Fixed in PR #79 |
| 3 | High | Web UI "Approve + apply" always fails and burns the proposal | From code | Fixed in PR #79 |
| 4 | High | Email is used as identity but never verified | From code | Fixed in PR #79 |
| 5 | High | Anyone can overwrite a registered OAuth client | From code | Fixed in PR #79 |
| 6 | Medium | v11 writes can be built on a stale published version | From code | Partly fixed (TODO.md) |
| 7 | Medium | v11 client retries POST and has no timeouts | From code | Fixed |
| 8 | Medium | Kept connections are resent in read shape | From code and docs | Open (TODO.md) |
| 9 | Medium | Service and connection writes are not atomic | From code | Open (TODO.md) |
| 10 | Medium | OAuth grant scope (tenant, environment) is not enforced everywhere | From code | Fixed (2026-11-17) |
| 11 | Medium | OAuth server hardening gaps | From code | Fixed |
| 12 | Medium | No rate limits or input validation on auth routes | From code | Fixed |
| 13 | Medium | Row-level security depends on which database role the app uses | Needs checking on staging | Fixed |
| 14 | Medium | Tenant governance gaps | From code | Open (TODO.md) |
| 15 | Medium | Dependency advisories | `npm audit` | Fixed |

## High severity

### 1. A resolved proposal can be applied again

`resolveProposal` in `src/mcp/proposalQueue.ts` never checks that the proposal is still `pending` before it writes. For `approve_and_apply` it calls `handler.apply(...)` first and only then `markResolved`, which is the step that notices the proposal was already resolved.

Reproduced with a throwaway unit test: queue a change, reject it, then call `approve_and_apply`. The call ends with `ProposalAlreadyResolvedError`, but the adapter had already been written to once, the service carried the rejected name, and the proposal still said `rejected`.

Consequences:

- A rejected proposal can be written to PTV by anyone with Approver and Publisher rights.
- A repeated or concurrent `approve_and_apply` writes twice. For `service_create`, `channel_create` and the new sub-organisation kind that means duplicates in PTV.
- The audit log records a successful Apply while the proposal shows another status.
- In the failure branch `markResolved(..., 'failed')` throws the same error and hides the real one.

Fix: claim the proposal before writing, in one statement (for example `pending` to a new `applying` status, or a guarded update), and release or fail it afterwards. `approve_and_export` and `reject` are safe today only because they have no side effect before the transition.

### 2. MCP OAuth tokens work as full REST sessions

`verifyAccessToken` in `src/auth/jwt.ts` checks the signature and `sub` only. MCP access tokens (`src/mcp/oauthService.ts`) are signed with the same `JWT_SECRET` and algorithm and also carry `sub`, so the REST `authenticate` guard accepts them. Confirmed with a throwaway test, also for the 10-minute `tenant_selection` token.

An MCP client that was granted the narrowest connection (no organisation, v11 read-only) can therefore call the REST API as the user for an hour at a time, and for 30 days through its refresh token: resolve proposals, manage members, replace the PTV API-user credentials, in every tenant the user belongs to. CLAUDE.md already warns about the reverse direction, which is blocked by the `iss` and `aud` checks.

Fix: give session tokens their own audience or `typ` claim and require it in `verifyAccessToken`, or sign the two token families with different keys.

### 3. Web UI "Approve + apply" always fails and burns the proposal

`toolContextFromRequest` in `src/routes/context.ts` never sets `writeApiVersion`. `POST /tenants/:tenantId/proposals/:proposalId/resolve` with `approve_and_apply` therefore reaches `auditedApply`, which throws `WriteApiNotSelectedError` on its first line. The catch block in `resolveProposal` treats every error except `not_authorized` as a failed write and marks the proposal `failed`, which is terminal.

The button is shown to Publishers in `web/src/pages/ProposalQueuePage.tsx`. No test covers `approve_and_apply` over REST; the existing ones go through MCP. I read this from the code and did not run it against a database.

The same catch block also burns a proposal for causes that are not a failed write: a read-only MCP connection, missing or expired PTV credentials, a validation error, or a PTV outage. Fix: let the REST context take the write API version from the tenant's adapter configuration, and mark a proposal `failed` only once a write was actually attempted, or allow a retry from `failed`.

### 4. Email is used as identity but never verified

`/auth/register` is open and issues a verification token, but `emailVerifiedAt` is never read anywhere (`grep` finds only the two places that set it). Sign-in works without it.

Email is nevertheless what decides who a person is: a Tenant Admin adds members by email (`TenantService.addMember`), and OIDC sign-in links an IdP identity to an existing local account with the same email (`OidcService.resolveUser`). Someone can register a colleague's address with their own password and wait. Once that address is added to an organisation, or the real owner signs in through SSO and gets linked, both people share the account.

Fix: require a verified email before sign-in, before `addMember` accepts the account and before OIDC links to it. When SSO is on, consider closing password registration, or clearing the password when an account is first linked.

### 5. Anyone can overwrite a registered OAuth client

`POST /oauth/register` is unauthenticated, takes `client_id` from the request body and upserts (`ON CONFLICT (client_id) DO UPDATE` in `registerClient`). Client ids are visible in every authorize URL, so anyone can replace an existing client's `redirect_uris` with their own.

The sign-in and connection pages show neither the client's name nor the redirect host, so a user cannot tell that the authorization code will go somewhere else. PKCE does not help, because the attacker starts the flow with their own challenge.

Fix: always mint the client id on the server and never update on conflict. Show the client name and redirect host on the consent page.

## Medium severity

### 6. v11 writes can be built on a stale published version

`getLatestOrNull` in `src/ptv/v11/adapter.ts` swallows every error from `{type}/active/{id}` and falls back to the public read. That is right for reads. In `applyServiceChange`, `applyChannelChange` and `applyConnectionChange` it means a transient failure of the restricted read (network, 5xx, a failed API login) makes the PUT start from the published version. The `Modified` lock check then passes, and the PUT body is built from older data than PTV holds.

Two related gaps: organisations have no `active` read, so the `Modified` check in `applyOrganizationChange` can never trigger, and `applyConnectionChange` has no `Modified` check at all. Fix: in write paths, fall back only on 404 and fail on anything else.

### 7. v11 client retries POST and has no timeouts

`PtvV11Client.request` (`src/ptv/v11/client.ts`) retries every method up to three times on 429, 5xx and network errors. For `POST /Service`, `/ServiceChannel/{type}` and `/Organization` a retry after a response was lost can create the item twice. None of the PTV calls, including the API login in `auth/apiLogin.ts`, passes an abort signal, so a hung connection holds the request open indefinitely. Fix: do not retry POST, and add a timeout to every PTV fetch.

### 8. Kept connections are resent in read shape

`PUT /Connection/serviceId/{id}` replaces all of a service's connections. `relationToWrite` in `src/ptv/v11/connectionWrite.ts` resends the untouched ones exactly as read. `docs/ptv-v11-notes.md` says the read and write shapes differ (fax numbers sit among `phoneNumbers` on read but are `faxNumbers` on write; addresses need `type: 'Postal'`) and marks this path "Not yet verified live".

Adding or removing a channel, or editing one connection, on a service whose other connections carry fax numbers or addresses may be refused by PTV or lose that data. Fix: send every relation through `connectionDetailsToDomain` and `connectionDetailsToWire`, as the edited one already is, and verify on the test environment.

### 9. Service and connection writes are not atomic

`applyServiceChange` PUTs the service and then PUTs the connections. If the second call fails, PTV holds half the change and the proposal is marked `failed`. The diff shown afterwards will only list the connection part. Worth recording which step failed in the audit entry, so a person knows what to finish by hand.

### 10. OAuth grant scope is not enforced everywhere

An MCP connection is authorised for one organisation, one environment and chosen API versions. Two places step outside that:

- `resolveProposal` and `confirmManualPublish` switch to the proposal's own environment, so a connection made for the test environment can apply a production proposal with its test-scoped write API version.
- `resourceToolContext` in `src/mcp/tools/shared.ts` takes the tenant and environment from the resource URI, so a connection for organisation A, or one with no organisation, can read organisation B's resources.

Membership and role are still checked in both cases, so this is not a cross-tenant leak. It does mean the choices on the connection page are not a boundary. Together with finding 2 the grant scope is currently advisory.

### 11. OAuth server hardening

- `exchangeCode` reads the code row and marks it consumed in two statements without checking the update's row count. Two concurrent exchanges of one code both succeed.
- Refresh tokens live 30 days, are never rotated and have no revocation path. OAuth 2.1 expects rotation for public clients.
- The client-metadata fetch (`fetchCimdMetadata`) is reachable without sign-in through `GET /oauth/authorize`. Its private-address check misses IPv4-mapped IPv6 (`::ffff:10.0.0.1`) and `100.64.0.0/10`, resolves DNS separately from the fetch (rebinding), and reads an unbounded body when no `content-length` is sent.
- The sign-in and consent pages send no `Content-Security-Policy` or `X-Frame-Options`, so they can be framed.

### 12. No rate limits or input validation on auth routes

- `/auth/login`, `/auth/register`, `/auth/request-password-reset` and `POST /oauth/authorize` have no rate limit. Each login or registration costs an Argon2id hash, and password-reset mail can be requested without limit. Only `/oidc/login` has a limiter, and with `trustProxy` unset it is global behind a reverse proxy.
- The failed-login counter in `recordFailedLogin` is read, incremented and written back, so parallel guesses undercount.
- `register` and `resetPassword` accept any non-empty password and any string as email. Email is stored case-sensitively, while OIDC matches case-insensitively.
- Auth routes have no body schemas. A missing `token` or `refreshToken` reaches `hashToken(undefined)` and answers 500.
- `JWT_SECRET` is base64-decoded without a length check, so a short value gives a weak signing key.

### 13. Row-level security depends on the database role

The policies use `FORCE ROW LEVEL SECURITY`, which binds the table owner but not a superuser. `.env.example`, `docker-compose.yml` and CI all connect as `ptv_mcp`, which is the Postgres image's superuser there, and `docker-compose.production.yml` takes a single `DATABASE_URL`. If staging or production connects with a superuser or `BYPASSRLS` role, the second isolation layer is silently off. Check with `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`, and consider refusing to start when either is true.

### 14. Tenant governance

- Any registered account can create organisations (`POST /tenants`), and registration is open.
- The last Tenant Admin can remove or demote themselves, leaving an organisation nobody can manage.
- A required reviewer who is later removed from the organisation blocks approval for good; only reject remains.
- `addMember` answers "No user registered with email", which lets any Tenant Admin, and so any registered account, test which addresses have accounts.

### 15. Dependency advisories

`npm audit --omit=dev` lists 12 advisories, 3 of them high, including zod below 4.6.6 (memory exhaustion on oversized collections) and `qs`. `npm audit fix` is offered for all of them.

## PTV v11 completeness

Service reads, service PUT and POST, publishing status handling and adding or removing connections are implemented and, per `docs/ptv-v11-notes.md`, verified against the test environment. What is left before v11 can be called finished:

| Area | State | What is missing |
| --- | --- | --- |
| Connection extra info (`connection_update`) | Implemented, not verified live | A live PUT with charge type, hours, fax and address; see finding 8 |
| Organisation PUT and POST | Mapped from the schema, not verified live | Whether the PUT needs `organizationType` or the area resent; archiving with `Deleted` |
| Organisation drafts | No `Organization/active` read exists | A draft sub-organisation cannot be read back, and the `Modified` lock check cannot work (finding 6) |
| Per-user OAuth consent | Unit-tested against mocks only | Never run against a registered PTV client; superseded for writes by the organisation API user |
| General descriptions, service collections | Read only | No write methods on the adapter, although `deleteFlags.ts` carries their flags; fine if out of scope, worth stating |
| Ontology term search | Not available on v11 | By design: the adapter throws `OntologySearchUnsupportedError` and points to v12 |

The per-user OAuth path (`src/routes/ptvConnections.ts`, `src/ptv/v11/auth/oauth.ts`) has loose ends that matter if it stays:

- The `state` returned by `/ptv-connections/v11/authorize-url` is never stored or compared in the callback.
- The authorize URL is always the production host, whatever `environment` is passed.
- `getDecryptedConnection` checks only `revokedAt`, not `expiresAt`. An expired token is then sent on every public GET, which v11 answers with 500 according to the client's own comment.

My recommendation is to remove this path or mark it clearly as dormant, since writes and draft reads now go through the API user.

Smaller v11 points:

- `PUT /tenants/:tenantId/ptv/v11/api-user` saves the credentials and switches on write support without a test login. A typo is only found on the first write.
- The same route stores `supportsDraftRead: false`, while the adapter built from those credentials reports `true`.
- On the test environment every API login first tries `/connect/token`, then `/api/auth/api-login`. The file's own header comment says `/connect/token` answered 500 to JSON; it is now sent a form body, and whether that works is not recorded.
- A linked general description's classifications are filtered out before a PUT, but when filtering would empty a list the unfiltered list is sent. That is documented, and it can turn inherited entries into the service's own.

## Low severity and quality

- The audit log is append-only by convention: migration 0001 grants the app role UPDATE and DELETE on every table, `audit_entries` included. Sign-ins, password and OIDC, are not audited.
- `proposalQueue` records the audit entry and the proposal row in separate transactions, so one can exist without the other.
- Envelope encryption uses AES-256-GCM without associated data, so an encrypted credential is not bound to its row.
- The API-user token cache keys on the plaintext password, kept in process memory.
- `searchServiceCollections` fetches up to 100 collections at once with `Promise.all`, outside the `PAGE_FETCH_CONCURRENCY` limit used elsewhere.
- Two concurrent organisation searches on a stale cache both download the national organisation catalogue.
- The Docker image runs as root; the Node image's `node` user is not used.
- The web UI keeps the session, refresh token included, in `localStorage`.
- `httpTransport.ts`'s header comment still says tenant and environment are tool arguments; they come from the token. `ToolContext.apiVersion` is deprecated but still read.
- `PLAN.md` still has an unchecked Phase 2 item for wiring `PtvAdapterConfig` for v11, which is done.
- The Drizzle snapshot stops at 0005, so `npm run db:generate` no longer produces usable migrations and 0017 to 0025 are hand-written. Regenerating the snapshot would restore the tool.

What is in good shape: the adapter boundary holds (no raw PTV JSON outside `src/ptv/v11` and `v12`), opaque tokens are stored hashed, PKCE is S256 only, the OIDC state handling is careful (server-side, single use, cookie-bound), tenant checks run before credential lookups, and resolve re-diffs against live PTV instead of trusting the stored diff.

## Suggested order

1. Findings 1 and 3 together: both are in `resolveProposal`, and a status claim before the write fixes both.
2. Finding 2: one claim check in `src/auth/jwt.ts`.
3. Findings 4 and 5 before any outside user gets an account.
4. Findings 6 to 8 before the next round of live v11 write tests, since they decide what those tests should cover.

## Fix plans for the high findings

These four plans cover findings 1 to 5 and were implemented in PR #79. The medium findings have no plans yet.

### Plan A: proposal apply flow (findings 1 and 3)

- New proposal status `applying` (migration 0026). `approve_and_apply` first claims the proposal with one guarded update from `pending` to `applying`, then writes to PTV, then moves it to `applied` or `failed`. A second or late call finds it no longer pending and writes nothing.
- Every resolve action checks that the proposal is still pending before doing anything.
- Errors raised before a write was attempted (no write API selected, adapter or credential cannot be resolved, validation failed) release the claim, so the proposal stays pending. Only an error from the write itself marks it `failed`.
- The REST resolve route picks the write API version from the organisation's adapter configuration for the proposal's environment (v11 when both exist, or the one named in the request), so the web UI's "Approve + apply" works.

### Plan B: separate session tokens from MCP tokens (finding 2)

- Web session tokens get the audience `ptv-mcp:session`, and the REST guard requires it. MCP access tokens and connection-selection tokens carry a different audience and are refused.
- Sessions issued before the deploy stop working within their 15-minute lifetime and are renewed through the refresh token as usual.

### Plan C: email as identity (finding 4)

- When SSO links to an existing local account whose email was never verified, that account's password and sessions are dropped first. The real owner can set a password again through password reset.
- New setting `REQUIRE_VERIFIED_EMAIL`, off by default. When on, sign-in and adding a member both require a verified email.
- It is off by default because the application has no mail provider yet: verification links are only written to the log, so switching it on today would lock out every password account.

### Plan D: OAuth client registration (finding 5)

- `/oauth/register` always mints the client id on the server and never updates an existing client.
- Redirect URIs are validated: https, http only on localhost, app schemes allowed, `javascript:` and similar refused.
- The sign-in page and the connection page show the application's name and where the user will be sent.

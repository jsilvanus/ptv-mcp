# ptv-mcp

Palvelutietovarannon käyttöön tarkoitettu MCP

A multi-tenant MCP server bridging Suomi.fi Palvelutietovaranto (PTV) and
AI agents. See [`docs/plan.md`](./docs/plan.md) for the architecture,
[`docs/phase-plan.md`](./docs/phase-plan.md) for the build sequence,
[`docs/ptv-v11-notes.md`](./docs/ptv-v11-notes.md) and
[`docs/ptv-v12-notes.md`](./docs/ptv-v12-notes.md) for the PTV v11/v12 API
findings, [`docs/deployment-guide.md`](./docs/deployment-guide.md) for
deployment, and
[`docs/adapter-onboarding-runbook.md`](./docs/adapter-onboarding-runbook.md)
for new adapter bring-up. `PLAN.md` and `EXECUTION_LOG.md` track live
implementation progress against the phase plan — both adapters
(`PtvV11Adapter`, `PtvV12Adapter`) are live side by side today; see
`PLAN.md`'s Phase 9 entry for the current state and known gaps.

## Guides and skills

`guides/` holds the PTV content-production rules condensed from DVV's
guidelines (`content-quality.md`, with a review checklist), PTV onboarding
(`getting-started-with-ptv.md`), API credentials (`api-credentials.md`)
and the AI-compliance rules (`ai-compliance.md`). `skills/` holds the
`ptv-mcp-admin` and `ptv-mcp-workflow` skills. The MCP serves all of them
through the `ptv_get_guide` tool, `ptv-guide://{topic}` resources and the
`ptv_review_content` / `ptv_content_workflow` / `ptv_admin_setup` prompts
(`src/mcp/guides.ts`).

## Local development

Requires Node.js 22+ and a PostgreSQL 16 instance.

```bash
cp .env.example .env    # fill in MASTER_ENCRYPTION_KEY for local dev
npm install
```

Database setup (once per fresh database):

```bash
# One-time, requires a superuser (or CREATEROLE) connection —
# never run as the application's own DB role. See the file itself.
psql -h localhost -U <superuser> -d ptv_mcp_dev -f scripts/bootstrap-roles.sql

npm run db:migrate
npm run db:seed   # optional: local dev fixtures
```

Or via Docker Compose, which runs the bootstrap script automatically:

```bash
docker compose up
```

## Single sign-on (OpenID Connect)

ptv-mcp can let people sign in through an OpenID Connect identity provider
(for example authentik). ptv-mcp is only a *Relying Party* toward the IdP:
it never issues ID tokens and publishes no JWKS. It stays the OAuth
authorization server and resource server for MCP clients (`/oauth/*`,
`/mcp`), so MCP clients, consent and the PTV connection choice work as
before; OIDC only adds another way to sign in.

OIDC is off unless `OIDC_ISSUER` is set. When it is set, the web UI login
page and the MCP authorization page show a single sign-on button next to
the email + password form (password sign-in keeps working).

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | Issuer URL exactly as the IdP publishes it (authentik: `https://auth.example.org/application/o/<slug>/`, keep the trailing slash). Unset or empty = OIDC off: no button, every `/oidc/*` route is a 404. `https:` is required when `NODE_ENV=production`. |
| `OIDC_CLIENT_ID` | Required when `OIDC_ISSUER` is set. |
| `OIDC_CLIENT_SECRET` | Optional. Set = confidential client (HTTP Basic client authentication); unset = public client. PKCE is always used. |
| `OIDC_SCOPES` | Default `openid email profile`; must contain `openid`. |
| `OIDC_BUTTON_LABEL` | Button text. Default `Sign in with single sign-on`. |
| `OIDC_CREATE_USERS` | `true` = create a ptv-mcp account (no password, no memberships) for an IdP user who has none. Default `false`. Only created from a trusted email (see below). |
| `OIDC_TRUST_EMAIL` | `true` = link to an existing account by email even when the IdP does not say `email_verified: true`. Default `false`. |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | Where the IdP returns the browser after sign-out (RP-initiated logout). Default `<MCP public URL>/login`; register it at the IdP. |
| `AUTH_MODE` | `both` (default with OIDC) = password and SSO. `oidc` = SSO only (see below). `local` = password only; refused while `OIDC_ISSUER` is set. `oidc` and `both` require `OIDC_ISSUER`. |
| `OIDC_BREAK_GLASS_EMAILS` | Comma-separated emails that keep password sign-in in `oidc` mode. Empty = no break-glass account. |
| `OIDC_GROUP_SYNC` | `true` = groups from the IdP grant tenant roles at each SSO sign-in (see "Group sync" below). Default `false` (automatically enabled if `OIDC_GROUP_ROLE_MAP` is set). Needs `OIDC_ISSUER`. |
| `OIDC_GROUPS_CLAIM` | The claim that lists the user's groups, read from the ID token or else from userinfo. Default `groups`. Used only with `OIDC_GROUP_SYNC=true`. |
| `OIDC_GROUP_PREFIX` | Prefix of the groups hierarchy; leading `/` is stripped and a trailing `/` is added if missing. Default `parish/`. Matches the structure used by Tavaranpaikka. |
| `OIDC_GROUP_APP` | Comma-separated list of application names recognized in `<prefix><tenant-slug>/<app>-<role>`. Default `ptv,ptv-mcp`. |
| `OIDC_GROUP_ROLE_MAP` | Optional JSON string matching Tavaranpaikka's `OIDC_GROUP_ROLE_MAP` (e.g. `{"parish/riihimaki":"viewer","parish/riihimaki/ptv-publisher":"publisher"}` or multi-tenant format). |

### SSO-only mode (`AUTH_MODE=oidc`)

With `AUTH_MODE=oidc`, sign-in goes through the IdP only:

- The web UI login page and the MCP authorization page show the SSO button. The
  password form is hidden behind a "Break-glass sign-in" section.
- Password sign-in (`POST /auth/login`, the MCP password form, and the token
  helper) is accepted only for emails in `OIDC_BREAK_GLASS_EMAILS`. Any other
  account gets the same "Invalid email or password" answer whatever password is
  sent.
- `POST /auth/register` returns 403 (accounts come from SSO, see
  `OIDC_CREATE_USERS`), and password reset mails are sent only to break-glass
  accounts.

Keep at least one break-glass administrator with a password before you switch
on `oidc`, and list it in `OIDC_BREAK_GLASS_EMAILS`. Otherwise an IdP outage
locks everyone out. Startup logs a warning when the list is empty.

The redirect URI is `<MCP_PUBLIC_URL>/oidc/callback`, one for both the web
UI and MCP sign-ins, so `MCP_PUBLIC_URL` must be the public URL the browser
uses. Invalid values (missing client id, a non-URL issuer, `http:` in
production, scopes without `openid`, booleans other than `true`/`false`)
stop the server at startup.

How an IdP identity finds its ptv-mcp account:

1. An identity (issuer + `sub`) linked before (`oidc_identities`) signs in
   as that account.
2. Otherwise an account with the same email (case-insensitive) is linked,
   if the email is verified by the IdP or `OIDC_TRUST_EMAIL=true`.
3. Otherwise, with `OIDC_CREATE_USERS=true` and a trusted email, a new
   account is created. It has no memberships until a tenant admin adds it,
   or until a group grants one (below).
4. Otherwise sign-in is refused ("No account for this sign-in; ask the
   administrator.").

### Group sync (`OIDC_GROUP_SYNC=true`)

With group sync on, the groups claim decides the tenant memberships that the
IdP grants. It matches the structure used by Tavaranpaikka:
`parish/<tenant-slug>[/<app>-<role>]`. It is checked at every SSO sign-in, for
the account that signed in:

| Group | Grants |
| --- | --- |
| `<prefix><tenant-slug>` (e.g. `parish/riihimaki`) | Viewer in that tenant |
| `<prefix><tenant-slug>/<app>-viewer` | Viewer |
| `<prefix><tenant-slug>/<app>-contributor` | Contributor |
| `<prefix><tenant-slug>/<app>-approver` | Approver |
| `<prefix><tenant-slug>/<app>-publisher` | Publisher |
| `<prefix><tenant-slug>/<app>-admin` or `.../tenant_admin` | Administrator (`tenant_admin`) |

App identifiers `<app>` default to `ptv` and `ptv-mcp` (customizable via
`OIDC_GROUP_APP`). Groups for other applications sharing the same parish tree
(e.g. `parish/riihimaki/tavaranpaikka-keeper` or `tavaranpaikka-admin`) are
silently ignored. Leading slashes (e.g. `/parish/riihimaki`) are normalized.

For example, with the default prefix `parish/`, the group `parish/riihimaki/ptv-publisher`
grants Publisher in the tenant whose slug is `riihimaki`. A bare `parish/riihimaki`
grants Viewer. Several groups for one tenant give the highest role. Groups without
the prefix are ignored, and so are unknown tenant slugs. Malformed names under
the app namespace are reported as ignored and logged.

Alternatively, explicit JSON mapping can be provided via `OIDC_GROUP_ROLE_MAP`,
matching Tavaranpaikka's structure:
`{"parish/riihimaki":"viewer","parish/riihimaki/ptv-publisher":"publisher","parish/riihimaki/ptv-admin":"tenant_admin"}`
or multi-tenant `{"parish/riihimaki":{"org":"riihimaki","role":"viewer"}}`.

- **Manual rows win.** A membership that a tenant admin set by hand (or
  changed in the UI) is never changed or removed by a group. Changing a role
  by hand makes the row manual.
- **Rows from groups follow the groups.** A group-granted membership whose
  group is no longer sent is removed at the next SSO sign-in. A user who
  has no groups claim at all loses all group-granted memberships. Check
  that the IdP sends the claim (scope or mapper) before you turn this on.
- **Timing.** Changes apply at the next SSO sign-in. The server does not ask
  the IdP between sign-ins, so a removed group keeps its access until then.
- Each change is recorded in the tenant's audit log
  (`AddGroupMembership`, `UpdateGroupMembership`, `RemoveGroupMembership`).

A temporarily locked account (too many wrong passwords) is refused on the
OIDC path as well. Who may sign in at all is decided by the IdP (in
authentik: the application's policy bindings).

Item 2 above links an account that never verified its email (for example one
registered through the open `/auth/register`, whose address may belong to
someone else) only after dropping its password and revoking its sessions:
the IdP-verified owner gets the account and can set a password again
through password reset. An account whose email was already verified is
linked as before, password unchanged.

### authentik

1. *Applications → Providers → Create → OAuth2/OpenID Provider*: client
   type **Confidential**, redirect URI `<MCP_PUBLIC_URL>/oidc/callback`
   (strict), and a **signing key** (so ID tokens are RS256). The default
   `openid`, `email` and `profile` scope mappings are enough.
2. *Applications → Create*: link it to the provider; bind policies/groups
   to decide who may sign in.
3. Copy the provider's client ID and secret to `OIDC_CLIENT_ID` /
   `OIDC_CLIENT_SECRET` and its *OpenID Configuration Issuer* URL to
   `OIDC_ISSUER`.

### Generic oidc-provider-based providers

Any issuer built on [panva's `oidc-provider`](https://github.com/panva/node-oidc-provider)
works with the same settings. `src/oidc/oidcProvider.integration.test.ts`
runs ptv-mcp's sign-in against such a provider in-process, once with a root
issuer and once with a path-prefixed issuer (`http://127.0.0.1:<port>/idp`,
no trailing slash), for both the web sign-in and the MCP authorization. The
provider in that test is configured the way ptv-mcp expects:

- `pkce.required` true, `S256` method
- `id_token_signed_response_alg: 'RS256'` with an RS256 signing key in `jwks`
- `token_endpoint_auth_method: 'client_secret_basic'`
- `conformIdTokenClaims: false`, so the `email`, `profile` and `groups` claims
  are released in the ID token
- a `groups` scope, requested with `OIDC_SCOPES="openid email profile groups"`
- redirect URI `<MCP_PUBLIC_URL>/oidc/callback` on the client

For a path-prefixed issuer, mount the provider under that path in your host
application the way koa-mount does (strip the prefix for routing, keep the full
path as `originalUrl`), so discovery advertises endpoints under the same prefix.

## PTV v12 raw-response debugging

Set `PTV_V12_DEBUG_RAW=true` to print successful v12 API responses to the
server console before they are mapped into the MCP domain model. This is
intended for temporary integration debugging; responses can contain public
PTV content and should not be enabled in routine production operation.

## Production

- Use `docker-compose.production.yml` for production container runtime.
- Production database is external (`DATABASE_URL`), not bundled in compose.
- CI/CD image build + publish workflow: `.github/workflows/deploy.yml`.

### Verified email (`REQUIRE_VERIFIED_EMAIL`)

`/auth/register` is open, and until a real mail provider is configured
(`LoggingMailer` only logs) nothing proves that an address belongs to the
person who registered it. Keep `REQUIRE_VERIFIED_EMAIL` at its default
`false` until one is, then set it to `true`: sign-in (password and OIDC)
refuses an account whose email is not verified, and adding a member to an
organisation requires a verified account. The password-sign-in refusal is
only given after the right password, so it does not reveal which emails
exist.

### Database role and row-level security

Tenant isolation has a second layer in Postgres row-level security, and a
superuser or `BYPASSRLS` role ignores it. At startup the server checks the
role in `DATABASE_URL` (`pg_roles`): with `NODE_ENV=production` it refuses to
start when the role is a superuser or has `BYPASSRLS`, otherwise it logs a
warning. Connect as a plain role in production. `ALLOW_PRIVILEGED_DB_ROLE=true`
turns the refusal into a warning. The compose and CI setups connect as the
image's superuser, so they only warn.

Common tasks:

```bash
npm run dev              # start the API with hot reload
npm test                 # unit tests (no DB required)
npm run test:integration # RLS / DB-backed tests (requires a migrated DB)
npm run lint
npm run typecheck
npm run build
```

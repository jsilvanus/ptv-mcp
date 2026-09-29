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
   account is created. Tenant admins still add it to organisations and pick
   its role; nothing about roles comes from the IdP.
4. Otherwise sign-in is refused ("No account for this sign-in; ask the
   administrator.").

A temporarily locked account (too many wrong passwords) is refused on the
OIDC path as well. Who may sign in at all is decided by the IdP (in
authentik: the application's policy bindings).

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

## PTV v12 raw-response debugging

Set `PTV_V12_DEBUG_RAW=true` to print successful v12 API responses to the
server console before they are mapped into the MCP domain model. This is
intended for temporary integration debugging; responses can contain public
PTV content and should not be enabled in routine production operation.

## Production

- Use `docker-compose.production.yml` for production container runtime.
- Production database is external (`DATABASE_URL`), not bundled in compose.
- CI/CD image build + publish workflow: `.github/workflows/deploy.yml`.

Common tasks:

```bash
npm run dev              # start the API with hot reload
npm test                 # unit tests (no DB required)
npm run test:integration # RLS / DB-backed tests (requires a migrated DB)
npm run lint
npm run typecheck
npm run build
```

---
name: ptv-mcp-admin
description: Set up and administer the ptv-mcp server for an organisation (e.g. a parish or parish union). Covers user accounts, tenants, member roles, PTV connections and API keys, connecting an AI client over MCP OAuth, and the settings that need checking. Use when someone asks how to start using this MCP, add a user, change a role, connect PTV, or why a tool says "not authorized" or that no adapter is configured.
---

# ptv-mcp administration

This skill walks a **Pääkäyttäjä** (Administrator, `tenant_admin`; "Tenant Admin" below) and the server operator through
setting up ptv-mcp for an organisation. Doing it for the AI assistant:
most steps happen in the ptv-mcp **web UI** or in DVV's services. Guide
the user step by step and check each prerequisite. Never ask the user for
passwords, API keys or tokens.

Related guides (read them with the `ptv_get_guide` tool or the
`ptv-guide://` resources):

- `getting-started`: the organisation's own PTV adoption with DVV (permit,
  PTV roles, training). **This must be done first.**
- `api-credentials`: how to get PTV API credentials.
- `ai-compliance`: editorial-responsibility rules.

## 0. Prerequisites outside this MCP

1. The organisation has a **PTV permit**, and a published organisation in
   PTV in every language it will use. Check with `ptv_search_organisations`
   or `ptv_find_organisation_and_children`.
2. For writing through the MCP: an **IN API permit** and API credentials
   from DVV (see `api-credentials`). v12 credential instructions are not
   yet published by DVV. Until then the MCP can read through v12, and
   write only through legacy setups or through *approve and export* for
   manual publishing in the PTV UI.
3. The people who will approve changes have completed **PTV-ajokortti**
   and understand the `ai-compliance` rules.

## 1. Server settings (operator, once per deployment)

Set by whoever runs the server; see `docs/deployment-guide.md`:

| Setting                 | Purpose                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | PostgreSQL. Run the role bootstrap (`scripts/bootstrap-roles.sql`) once as superuser, then `npm run db:migrate`.                                |
| `MASTER_ENCRYPTION_KEY` | 32 random bytes (base64). Encrypts stored PTV credentials. **Back it up securely.** Losing it makes the stored keys unreadable.             |
| `JWT_SECRET`            | 32 random bytes (base64). Signs login and MCP tokens. It is separate from the encryption key.                                                   |
| `MCP_PUBLIC_URL`        | The public HTTPS base URL, **without** `/mcp`. MCP clients connect to `<MCP_PUBLIC_URL>/mcp`, and OAuth discovery is derived from it.          |
| `PTV_V11_OAUTH_*`       | Only for legacy v11 per-user connections. Leave empty otherwise.                                                                                |

After deploying, check that `GET /health` returns `{"status":"ok"}`.

## 2. Create accounts and the tenant

A **tenant** is one PTV organisation (e.g. a parish union) in ptv-mcp.

1. Each person **registers** in the web UI (*Register*: email, name and
   password). Users can only be added to a tenant after they have
   registered.
2. The first administrator logs in and opens **Tenants → Create a tenant**
   (name and a short slug). The creator automatically becomes that
   tenant's **Tenant Admin**.
3. In **Members → Add a member**, add each registered user by email with a
   role.

### Choosing roles

| MCP role                          | Can do                                                                                                                                     | Give to                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Katselija** (Viewer)            | Read the organisation's PTV data, drafts included, and run the automated quality check                                                    | People who only need to look                                                      |
| **Ehdottaja** (Contributor)       | Plus **propose** changes (queued, not written), comment, sign off as a required reviewer, and review the items of a review campaign assigned to them | Staff who know the activity: the reviewers of a review campaign                   |
| **Hyväksyjä** (Approver)          | Plus **resolve** proposals: reject, or approve and export for manual publishing in PTV's own UI                                            | PTV maintainers (PTV-ylläpitäjä)                                                  |
| **Julkaisija** (Publisher)        | Plus **approve and apply** (write to PTV; needs a write-capable PTV connection), and **start and run review campaigns**                   | PTV main users / trained maintainers who also have PTV rights in Palveluhallinta |
| **Pääkäyttäjä** (Administrator, `tenant_admin`) | Everything, plus members, roles, PTV connections, tenant settings (four-eyes) and the audit log                           | One or two PTV main users (PTV-pääkäyttäjä)                                       |

Principles:

- **Least privilege.** Give Julkaisija only to people who are allowed to
  publish the organisation's official information and who have done PTV
  training. Keep **at least two administrators**, mirroring DVV's rule of a
  main user plus a deputy.
- **Four-eyes** is on by default, so nobody resolves their own proposal. A
  very small parish with one PTV person can switch it off in the
  organisation settings. Keep it on if you can: it is the strongest
  evidence of human editorial control.
- **Remove people promptly** when they change jobs, and review members at
  least once a year. Role changes are recorded in the audit log.

## 3. Connect PTV (Tenant Admin)

Open **PTV connections** in the web UI.

- **v12 (recommended, current API):** *Connect a PTV v12 API key*. Choose
  the environment (`test` first, then `production`), paste the key from
  DVV, and run the connection test. v12 is currently **read-only** in this
  MCP.
- **v11 (legacy, being retired):** existing setups only. This guide
  intentionally doesn't cover new v11 setups.
- Use the **test** environment first to try out the workflow, then set up
  **production**.

If a tool says no adapter is configured or credentials are missing, it
means the tenant has no connection for that environment and API version.
Only a Tenant Admin can fix this.

## 4. Connect the AI client (each user)

1. In the AI client (for example Claude), add a custom MCP connector
   pointing to `<MCP_PUBLIC_URL>/mcp`.
2. The client opens the ptv-mcp sign-in page. Sign in with your ptv-mcp
   account.
3. On **Choose PTV connection**, select:
   - the **organisation** (tenant),
   - the **environment** (test or production),
   - the **read API version** (v12 recommended),
   - the **write API version**, or **NONE**. NONE makes the session
     read-only: changes to existing services can still be proposed, but
     new-service and channel proposals and all writes are refused. Select
     a write version if the user needs to propose new services or channel
     changes. Proposals are still only queued; nothing is written until a
     human approves it.
4. To change the organisation or environment later, reconnect the
   connector. A token is bound to one tenant and environment.

## 5. Check that it works

Ask the AI assistant to:

1. `ptv_find_organisation_and_children` for your organisation. This
   confirms read access.
2. Propose a harmless test change in the **test** environment, then open
   **Proposal queue** in the web UI and reject it. This confirms the
   proposal flow and your role.
3. Look at the **Audit log** (Tenant Admin). You should see both steps
   under one correlation ID.

## Troubleshooting

| Symptom                                           | Likely cause and fix                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| "Your account is not a member of any PTV organisation" | A Tenant Admin must add the user under Members.                                                                                       |
| `not_authorized` / insufficient role              | The user's role is too low for the action; check the role table above.                                                                      |
| No adapter / credentials for environment          | Add the PTV connection for that environment (step 3) or reconnect choosing a configured environment.                                       |
| "PTV v12 write operations are not enabled yet"    | Expected. Use approve and export and publish manually in the PTV UI, or wait for v12 write support.                                        |
| Authentication required                           | The MCP token has expired or is missing. Reconnect the connector in the AI client.                                                         |
| Can't publish a new language version              | The organisation isn't published in that language in PTV. Publish the organisation language version first.                                |

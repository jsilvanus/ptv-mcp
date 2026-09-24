# Roles and proposal review: plan

Agreed 2026-09-24. Replaces the Reader < Editor < Publisher < Tenant Admin
model in `src/auth/rbac.ts`.

## Roles

| Role (id) | FI label | EN label | Can |
|---|---|---|---|
| any logged-in user (no membership) | – | – | read published PTV data (v11, no drafts) |
| `viewer` | Katselija | Viewer | read the tenant's PTV data, drafts included |
| `contributor` | Ehdottaja | Contributor | + view, comment on and create proposals |
| `approver` | Hyväksyjä | Approver | + resolve: approve + export, reject |
| `publisher` | Julkaisija | Publisher | + approve + apply (write to PTV) |
| `tenant_admin` | Pääkäyttäjä | Administrator | + members, PTV credentials, tenant settings |

The ids are stable and stored in the database; the UI shows the labels.
`tenant_admin` keeps its old id to avoid a wide rename.

Migration: the old `reader` could create proposals, so it becomes
`contributor`; `editor` becomes `approver` (Postgres `RENAME VALUE`, rows
keep their meaning). `viewer` is new.

## Rules

- **Four-eyes** (tenant setting, on by default): nobody resolves a
  proposal they created, except reject. Small parishes with one PTV person
  can switch it off.
- **Required reviewers**: the proposer or an Approver can name tenant
  members (Contributor or above) whose sign-off is needed. Each gives
  *Hyväksyn* (approve) or *Pyydän muutoksia* (request changes) with an
  optional comment. `approve_and_export` and `approve_and_apply` wait until
  every required reviewer has approved; reject is always possible. Four-eyes
  applies on top, so a sign-off plus a separate resolver can mean six eyes.
- Every comment and sign-off is audited under the proposal's correlation id.

## Steps (one PR each)

1. **Roles.** Enum migration, `ROLE_RANK`, role checks: propose = contributor,
   view proposals = contributor, resolve = approver (apply still needs
   publisher via the registry), reads = viewer. Web: labels, member roles.
2. **Reading without a tenant.** Any logged-in user can read published v11
   data through MCP without a tenant in the token. Drafts
   (`Service/active`) stay tenant-only because they use the tenant's API
   user.
3. **Proposal comments.** `proposal_comments` table (RLS), REST + MCP tool
   (`ptv_comment_proposal`), shown on the proposal page.
4. **Four-eyes.** `tenants.require_four_eyes` (default true), checked in
   `resolveProposal`; the direct `ptv_export_for_manual_publish` and
   `ptv_apply_changes` tools are refused while it is on. REST
   `GET/PUT /tenants/:id/settings` (read: Viewer, write: Tenant Admin,
   audited as `UpdateTenantSettings`); toggle on the members page.
5. **Required reviewers.** `proposal_reviewers` table (proposal, user,
   decision, comment, decided_at), MCP tools to request a review and to sign
   off, the gate in `resolveProposal`, and a "waiting for you" list in the
   web UI and `ptv_list_proposals`. Done: `ptv_request_review` (reviewers by
   email or id; without any it lists the possible ones) and
   `ptv_sign_off_proposal`; REST `POST .../reviewers`, `POST .../sign-off`,
   `GET /tenants/:id/review-candidates`, `?waitingForMe=true`. A sign-off
   can be changed while the proposal is pending; the proposer cannot be a
   reviewer.
6. **Diff view.** Classification names instead of raw JSON, a per-language
   export preview on the proposal page, and a readable preview of a new
   service.

Exit criteria per step: unit and integration tests for the rule, RLS
coverage for new tables (`src/db/rls.integration.test.ts`), audit entries,
and the web UI working against the deployed server.

Later, not planned now: rule-based required reviewers (e.g. "services with
life event KE14 always need the vicar") and notifications beyond the
web UI list.

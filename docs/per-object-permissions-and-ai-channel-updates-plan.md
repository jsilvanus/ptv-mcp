# Per-object permissions and AI-assisted channel updates — plan

Status: proposed next implementation task  
Repository: `jsilvanus/ptv-mcp`  
Related design: [Roles and proposal review](./roles-and-review-plan.md)

## Goal

Move from tenant-wide review policy alone to explicit, auditable permissions and review requirements at the individual PTV object level, while keeping the MCP proposal/apply workflow as the only path for AI-assisted changes.

Office workers should be able to ask an AI assistant to update an office channel's opening hours in natural language. The MCP must read the full current channel, propose a narrowly scoped change to `serviceHours`, show a human-readable diff, validate it, and publish only the opening-hours change when policy and permissions allow it.

This is an authorization and policy task first. The initial deliverable is the per-object permission and review-policy foundation; the opening-hours experience is the first consumer of that foundation.

## Core principles

1. **Server-side enforcement.** Permissions are enforced by the MCP/server for every relevant tool and route, never only by the prompt or UI.
2. **Least privilege, practical delegation.** A tenant administrator can grant a person authority over selected services/channels without giving them unrestricted tenant-wide publishing rights.
3. **Explicit exceptions.** A user may bypass a configured review requirement only through a deliberate, separately authorized action. Never silently skip review because a user asks in natural language.
4. **Narrow writes.** An opening-hours task may modify only `serviceHours`. It must not rewrite names, descriptions, addresses, contact details, publishing status, or other fields.
5. **Auditable decisions.** Record policy changes, grants, overrides, proposals, approvals, and PTV writes with actor, object, timestamp, reason where applicable, and correlation/proposal ID.
6. **Safe defaults and migration.** Existing tenants retain their current behaviour unless an administrator explicitly configures an override. Existing four-eyes and required-reviewer protections must not be weakened accidentally.
7. **AI is an interface, not an authority.** The model can interpret instructions and prepare a proposal; identity, permissions, policy evaluation, and publishing decisions remain server-side.

## 1. Per-object permission model

Support grants scoped to a PTV object, initially a service or a service channel. Use stable PTV object identifiers and record the object type. Do not use names as authorization identifiers.

A grant should include:
- tenant and member/user ID;
- object type and object ID (`service` or `channel`);
- allowed capabilities;
- grantor, creation/update timestamps, and optional expiry;
- audit metadata.

Capabilities should be distinct, rather than inferred from one broad role:

- **Read** the object and its current data.
- **Propose/edit** allowed fields on the object.
- **Review/sign off** another person's proposal for the object.
- **Approve/export** a proposal where the current workflow permits it.
- **Publish/apply** an approved change to PTV.
- **Manage access/policy** for that object (normally tenant-admin-only unless a future delegated administrator capability is deliberately added).

A person's existing tenant role remains an upper bound: an object grant must not give a member a capability their tenant role cannot exercise. For example, object-level publish permission cannot turn a Contributor into a Publisher. It can restrict where an already-authorized Publisher may publish.

### Service and channel scope

- A service grant applies to the service itself. It does **not** automatically grant access to every channel unless that inheritance is explicitly defined and shown to administrators.
- A channel grant applies only to that channel.
- If service-level inheritance is implemented, make it explicit, deterministic, and visible (for example, “inherited from service”), and define how a channel-specific deny/restriction interacts with it.
- Avoid implicit privilege expansion from a service to its channels or from one channel to another.
- Tenant administrators retain tenant-wide administration as defined by the existing role model.

### Object discovery

A user must not gain access simply by guessing a PTV object ID. Search/list/get results and proposal tools must respect tenant membership and the applicable object grants. The server must re-check authorization against the actual target object when queuing, reviewing, exporting, or applying a proposal.

## 2. Review policy per service/channel

Keep the tenant-level `require_four_eyes` setting as the default. Add a review policy at the service and channel levels with three states:

- `inherit`: use the parent/default policy;
- `required`: independent review is required;
- `not_required`: the normal review requirement may be bypassed for this object.

The effective policy should be computed server-side and exposed in a human-readable explanation. Precedence should be deterministic: channel override, then service override, then tenant default. A child object must not silently loosen an explicitly stricter parent policy unless the policy model deliberately allows it and the administrator makes that exception explicit.

The design must keep these controls distinct:

- **Four-eyes:** the person who resolves/applies a proposal must be different from its proposer.
- **Required reviewers:** named reviewers must sign off before the proposal can proceed.
- **Object permissions:** determine who can act on this service/channel and which capabilities they have.

Required reviewers may be configured per service/channel, with explicit inheritance/override behaviour. Review candidates must have suitable membership and review capability for the object. The proposer must not approve their own proposal or satisfy the independent-review requirement.

### Explicit override

Where policy allows exceptions, provide a dedicated MCP operation (and corresponding web/API support if applicable) to request an override. It must:
- require a separate explicit action, not an inferred natural-language intent;
- require a capability reserved for an authorized role (initially tenant administrator or an explicitly delegated policy manager);
- identify the exact object and proposal;
- require a reason;
- show the effective policy and what protection will be bypassed;
- record the actor, reason, prior/effective policy, timestamp, and proposal correlation ID;
- never bypass the actor's object permissions, PTV write capability, validation, or audit requirements;
- never retroactively alter unrelated proposals.

An override may waive only the review rule it names. It must not silently waive both four-eyes and required reviewers. Decide and document whether an override is one-proposal-only (recommended default) or a persistent object-policy change. Prefer one-proposal-only overrides for exceptional cases; persistent changes belong in an explicit policy-management operation.

For ordinary office work, the preferred setup is to grant office staff the necessary channel editing/proposal permissions and configure that channel not to require review if the organisation intentionally accepts that risk. An override is for exceptional cases, not the everyday workflow.

## 3. Required reviewers and object policy administration

Provide an administrator workflow to:
- select a service or channel;
- view current effective permissions and inherited grants;
- grant/revoke capabilities for individual members;
- choose review policy: inherit, required, or not required;
- choose required reviewers (specific members) and define whether the list inherits or overrides;
- inspect who changed the policy and when.

Prevent invalid configurations, such as assigning a reviewer who lacks access to the object. Warn when a policy permits a single person to propose and publish without review. Explain clearly that a tenant role and an object grant are both required.

## 4. MCP workflow for AI-assisted opening-hours changes

The AI should use the existing MCP tools and proposal system, not a separate direct-write path.

Expected sequence:

1. Resolve the user's authenticated identity and tenant membership.
2. Find the intended service/channel and verify object-level read and edit/propose permission.
3. Fetch the complete current channel. Never draft against guessed or stale data.
4. Interpret the user's requested opening-hours change. Ask a clarifying question when dates, days, time zones, exceptional hours, closures, or intended channel are ambiguous.
5. Construct a complete, valid `serviceHours` value while preserving unrelated existing opening-hour entries and metadata that should remain.
6. Submit a proposal containing **only** the `serviceHours` field. Reject attempts from this workflow to modify other fields.
7. Run the existing quality checks and PTV validation; show a readable before/after preview and explicitly list the fields to be changed.
8. Evaluate the effective object permissions, four-eyes policy, required reviewers, and any valid explicit override on the server.
9. If review is required, queue the proposal and tell the user who/what approval is pending. Do not apply it yet.
10. If review is not required, continue only if the user's role and object grant permit the applicable approval/publish actions. Make the publish action explicit and report success only after PTV confirms it.
11. Re-read the channel after a successful write and verify that the intended opening hours changed and unrelated fields remained unchanged.
12. Audit the complete operation.

### Field-level write protection

Add a field allowlist for the opening-hours workflow. The proposal payload must contain `serviceHours` and no other mutable field. Do not trust the AI to self-police this: enforce it in the server-side tool/schema and authorization logic. If a general proposal tool is used, validate the field set and reject any extra fields for this workflow.

Where feasible, add an optimistic concurrency check or compare the current channel against the version used to draft the proposal. If the channel has changed since it was read, stop and refresh/rebase rather than overwrite another person's changes.

## 5. Implementation phases

### Phase 1 — authorization and policy design (first task)

- Map all MCP tools and REST routes that read, propose, review, export, or apply service/channel changes.
- Define the object-grant and review-policy schemas, including migration and RLS strategy.
- Define effective-policy precedence, service-to-channel inheritance, and the exact meaning of override.
- Implement central server-side authorization/policy resolvers and use them on every relevant path.
- Keep current tenant defaults and behaviour during migration.
- Add audit events for grants, revocations, policy changes, and overrides.
- Add unit/integration tests proving that no alternate tool or route bypasses the policy.

**Exit criteria:** object permissions are enforced consistently; effective policy is deterministic; existing tenants retain their prior policy; migrations and RLS tests pass; unauthorized object-ID guessing and alternate write paths are covered by tests.

### Phase 2 — administration and reviewer assignment

- Add service/channel permission and policy views to the web interface.
- Add grant/revoke actions, required-reviewer configuration, and policy inheritance indicators.
- Add explicit override UI/API/MCP operation with reason and audit trail.
- Display effective permissions and policy in proposal details.

**Exit criteria:** a tenant administrator can configure an office channel without database access; all changes are audited and permission-checked.

### Phase 3 — AI opening-hours workflow

- Add/adjust MCP tooling and workflow instructions for reading a channel and preparing a service-hours-only proposal.
- Ensure the full channel is read first and only `serviceHours` can be changed by this workflow.
- Provide a clear human-readable diff, validation results, and publication status.
- Use existing proposal/reviewer/apply mechanisms and new object policy.
- Verify successful writes by reading the channel back.

**Exit criteria:** an authorized office worker can request a change in natural language; the assistant updates only opening hours; review is enforced or skipped according to effective policy; publication status is truthful and auditable.

### Phase 4 — hardening

- Test concurrent edits and stale proposals.
- Test inheritance, conflicting policies, revoked grants, removed reviewers, self-review, and attempted override misuse.
- Test every direct export/apply route and all channel types.
- Review logs for sensitive data minimization and ensure audit history is tenant-isolated.
- Document administrator guidance and staff workflow.

## 6. Required test matrix

At minimum, test:

- no object grant; read-only grant; propose grant; review grant; publish grant;
- tenant role is lower than the requested object capability;
- service grant versus channel-only grant and any configured inheritance;
- tenant default on/off and service/channel inherit/required/not-required overrides;
- required reviewers approve, request changes, are removed, or lose access;
- proposer tries to review or resolve their own proposal;
- user asks the AI to change opening hours and the generated payload includes another field;
- channel changes after the assistant reads it but before apply;
- override without permission, without reason, against the wrong proposal, or attempting to bypass unrelated controls;
- PTV validation failure and PTV write failure;
- successful apply followed by read-back verification;
- audit events and row-level security for every new table and route.

## 7. Decisions to settle before implementation

1. **Override authority:** recommendation: tenant administrator only initially; consider a separate delegated policy-manager capability later.
2. **Override duration:** recommendation: one proposal only, with a mandatory reason.
3. **Policy precedence:** channel-specific policy should normally win, but a stricter service/tenant policy should not be weakened accidentally. Decide whether administrators may explicitly loosen a stricter parent.
4. **Required reviewers:** decide whether reviewer lists inherit from service to channel or must be configured independently. Make the selected behaviour visible.
5. **Publish permission:** keep tenant role as an upper bound; object grants restrict scope but do not elevate a Contributor to Publisher.
6. **Routine office workflow:** if staff need to change office hours independently, explicitly grant them the appropriate object capability and configure that office channel's review policy accordingly. Do not make them repeatedly invoke emergency overrides.

## Related existing implementation

- `docs/roles-and-review-plan.md` — tenant roles, four-eyes, required reviewers, and proposal workflow.
- `src/mcp/channelProposal.ts` — channel proposal and writable field handling.
- `src/mcp/proposalQueue.ts` — proposal resolution and review enforcement.
- `src/mcp/tools/proposalTools.ts` — proposal MCP tools.
- `src/auth/authorization.ts` / current authorization modules — role enforcement (confirm exact current paths during implementation).
- `web/src/pages/TenantSettingsPanel.tsx` — current tenant-level four-eyes setting.

This document is a plan, not an assertion that the features above have been implemented.

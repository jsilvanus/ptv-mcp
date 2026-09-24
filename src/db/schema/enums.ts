import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Viewer < Contributor < Approver < Publisher < Tenant Admin, see
 * docs/roles-and-review-plan.md. UI labels: Katselija, Ehdottaja,
 * Hyväksyjä, Julkaisija, Pääkäyttäjä.
 */
export const membershipRoleEnum = pgEnum('membership_role', [
  'viewer',
  'contributor',
  'approver',
  'publisher',
  'tenant_admin',
]);

export const ptvEnvironmentEnum = pgEnum('ptv_environment', ['test', 'production']);

/**
 * Which table a PtvAdapter resolves its credential from — 'tenant' for a
 * shared organisational secret (TenantEnvironment, e.g. v12's API key),
 * 'user' for a personal one (UserPtvConnection, e.g. v11's OAuth token).
 * See docs/ptv-v11-notes.md's "Do we still need tenant_id" section.
 */
export const credentialScopeEnum = pgEnum('credential_scope', ['tenant', 'user']);

export const proposalStatusEnum = pgEnum('proposal_status', [
  'pending',
  'approved',
  'rejected',
  'applied',
  'failed',
]);

/**
 * What a proposal does: update an existing service (the original and
 * default kind), create a new service, or update a service channel. The
 * proposal's `service_id` holds the target entity's id: the service or
 * channel, or for `service_create` the new service's id once applied
 * (empty until then).
 */
export const proposalKindEnum = pgEnum('proposal_kind', [
  'service_update',
  'service_create',
  'channel_update',
]);

import { pgEnum } from 'drizzle-orm/pg-core';

/** Reader < Editor < Publisher < Tenant Admin, per docs/plan.md's role model. */
export const membershipRoleEnum = pgEnum('membership_role', [
  'reader',
  'editor',
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

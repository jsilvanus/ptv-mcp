import { ROLE_RANK, type MembershipRole } from '../auth/rbac.js';

export class NotAuthorizedError extends Error {
  constructor(tenantId: string, minRole: MembershipRole) {
    super(`Not authorized: this action requires at least '${minRole}' role for tenant ${tenantId}`);
    this.name = 'NotAuthorizedError';
  }
}

/**
 * Looks up a user's role for a tenant — in production this is
 * `(tenantId, userId) => resolveMembershipRole(db, tenantId, userId)`
 * (see auth/rbac.ts); tests can substitute a fixed-answer fake without
 * needing a real Postgres connection just to exercise this check.
 */
export type MembershipRoleResolver = (
  tenantId: string,
  userId: string,
) => Promise<MembershipRole | null>;

/**
 * `PtvAdapterRegistry.resolve()` only gates *PTV adapter/credential*
 * access (Reader for read, Publisher for write) — it has no notion of
 * our own business-action permissions, e.g. that only an Editor may
 * propose or export a change at all (docs/plan.md's role model: a Reader
 * "ei saa ehdottaa muutoksia"). Tool functions that aren't already
 * covered by the registry's own write-role check (`ptv_apply_changes`
 * is, via `operation: 'write'`) call this explicitly first.
 */
export async function requireTenantRole(
  resolveRole: MembershipRoleResolver,
  tenantId: string,
  userId: string,
  minRole: MembershipRole,
): Promise<void> {
  const role = await resolveRole(tenantId, userId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new NotAuthorizedError(tenantId, minRole);
  }
}

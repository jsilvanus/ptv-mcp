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
 * access (Viewer for read, Publisher for write) — it has no notion of
 * our own business-action permissions, e.g. that only a Contributor may
 * propose and only an Approver may resolve (docs/roles-and-review-plan.md;
 * a Viewer is read-only). Tool functions that aren't already
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

/** Whether a tenant enforces four-eyes (`tenants.require_four_eyes`). */
export type FourEyesResolver = (tenantId: string) => Promise<boolean>;

export class FourEyesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FourEyesError';
  }
}

/**
 * The direct `ptv_apply_changes` / `ptv_export_for_manual_publish` tools
 * skip the proposal queue, so one person would both write and approve
 * the change. With four-eyes on they are refused; the proposal flow
 * (`ptv_propose_changes` → someone else's `ptv_resolve_proposal`) remains.
 */
export async function requireNoFourEyes(
  requireFourEyes: FourEyesResolver,
  tenantId: string,
): Promise<void> {
  if (await requireFourEyes(tenantId)) {
    throw new FourEyesError(
      'This organisation requires four-eyes review: propose the change with ptv_propose_changes and have another member resolve it. A Pääkäyttäjä can switch four-eyes off in the organisation settings.',
    );
  }
}

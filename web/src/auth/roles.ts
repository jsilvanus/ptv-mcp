import type { MembershipRole } from '../api/types';

/** Lowest to highest; mirrors ROLE_RANK in src/auth/rbac.ts. */
export const ROLES: MembershipRole[] = [
  'viewer',
  'contributor',
  'approver',
  'publisher',
  'tenant_admin',
];

/** UI labels (docs/roles-and-review-plan.md). The ids stay stable in the database. */
export const ROLE_LABELS: Record<MembershipRole, string> = {
  viewer: 'Katselija (Viewer)',
  contributor: 'Ehdottaja (Contributor)',
  approver: 'Hyväksyjä (Approver)',
  publisher: 'Julkaisija (Publisher)',
  tenant_admin: 'Pääkäyttäjä (Administrator)',
};

export function roleAtLeast(role: MembershipRole | undefined, minRole: MembershipRole): boolean {
  return role !== undefined && ROLES.indexOf(role) >= ROLES.indexOf(minRole);
}

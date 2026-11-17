/**
 * Maps the IdP's groups to tenant roles (`OIDC_GROUP_SYNC`, phase B of the
 * sign-in plan). A group named `<prefix><tenant-slug>` grants Viewer in that
 * tenant; `<prefix><tenant-slug>/<role>` grants the role. Tenant Admin is
 * never granted from a group: it stays a manual decision.
 *
 * Pure: the database side lives in `OidcService.syncGroupMemberships`.
 */

/** The roles a group may grant, lowest first. */
export const GROUP_ROLES = ['viewer', 'contributor', 'approver', 'publisher'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export interface GroupGrants {
  /** Tenant slug to the highest role its groups grant. */
  grants: Map<string, GroupRole>;
  /** Groups under the prefix that name no grant (malformed, or a role a group may not grant). */
  ignored: string[];
}

const GROUP_PATTERN = /^([^/]+)(?:\/([^/]+))?$/;

function isGroupRole(value: string): value is GroupRole {
  return (GROUP_ROLES as readonly string[]).includes(value);
}

/** Groups outside the prefix are someone else's and are skipped silently. */
export function parseGroupGrants(groups: readonly string[], prefix: string): GroupGrants {
  const grants = new Map<string, GroupRole>();
  const ignored: string[] = [];
  for (const group of groups) {
    if (!group.startsWith(prefix)) continue;
    const match = GROUP_PATTERN.exec(group.slice(prefix.length));
    const slug = match?.[1];
    if (!match || !slug) {
      ignored.push(group);
      continue;
    }
    const suffix = match[2];
    const role: string = suffix === undefined ? 'viewer' : suffix;
    if (!isGroupRole(role)) {
      ignored.push(group);
      continue;
    }
    const current = grants.get(slug);
    if (!current || GROUP_ROLES.indexOf(role) > GROUP_ROLES.indexOf(current)) {
      grants.set(slug, role);
    }
  }
  return { grants, ignored };
}

/** The groups claim's value: a list of names, or a single name. Anything else is no groups. */
export function groupsFromClaim(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return undefined;
}

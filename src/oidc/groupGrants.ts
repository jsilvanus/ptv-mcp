/**
 * Maps the IdP's groups to tenant roles (`OIDC_GROUP_SYNC`, matching the structure
 * used by Tavaranpaikka: `parish/<tenant-slug>[/<app>-<role>]`).
 *
 * - A group named `<prefix><tenant-slug>` (e.g. `parish/riihimaki` or `/parish/riihimaki`)
 *   grants Viewer in that tenant.
 * - A group named `<prefix><tenant-slug>/<app>-<role>` (e.g. `parish/riihimaki/ptv-publisher`
 *   or `parish/riihimaki/ptv-mcp-contributor`) grants the named role.
 * - Role `admin` is accepted as an alias for `tenant_admin` (matching Tavaranpaikka's convention).
 * - App-scoped groups for other applications (e.g. `parish/riihimaki/tavaranpaikka-keeper`)
 *   are ignored silently.
 * - Explicit mapping via `groupRoleMap` (matching Tavaranpaikka's `OIDC_GROUP_ROLE_MAP`)
 *   is supported as well.
 *
 * Pure: the database side lives in `OidcService.syncGroupMemberships`.
 */

import { ROLE_RANK } from '../auth/rbac.js';

export const GROUP_ROLES = [
  'viewer',
  'contributor',
  'approver',
  'publisher',
  'tenant_admin',
] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export interface GroupGrants {
  /** Tenant slug to the highest role its groups grant. */
  grants: Map<string, GroupRole>;
  /** Groups under the prefix that name no grant (malformed, or unknown role for this app). */
  ignored: string[];
}

export interface GroupGrantsOptions {
  prefix?: string;
  apps?: readonly string[];
  groupRoleMap?: Record<string, string | { org?: string; role?: string }>;
  defaultTenantSlug?: string;
}

export function normalizeRole(value: string): GroupRole | undefined {
  const lower = value.trim().toLowerCase();
  if (lower === 'admin') return 'tenant_admin';
  if ((GROUP_ROLES as readonly string[]).includes(lower)) {
    return lower as GroupRole;
  }
  return undefined;
}

export function parseGroupGrants(
  groups: readonly string[],
  prefixOrOptions: string | GroupGrantsOptions = 'parish/',
): GroupGrants {
  const options: GroupGrantsOptions =
    typeof prefixOrOptions === 'string'
      ? { prefix: prefixOrOptions }
      : prefixOrOptions;

  const rawPrefix = (options.prefix ?? 'parish/').trim();
  const cleanPrefix = rawPrefix.replace(/^\/+/, '').replace(/\/+$/, '') + '/';

  // Sort apps by length descending so longer prefixes match first (e.g. "ptv-mcp" before "ptv")
  const rawApps = options.apps && options.apps.length > 0 ? options.apps : ['ptv', 'ptv-mcp'];
  const apps = [...rawApps]
    .map((a) => a.toLowerCase().trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const defaultTenantSlug = options.defaultTenantSlug || 'riihimaki';

  const normalizedMap = new Map<string, { org: string; role: GroupRole }>();
  if (options.groupRoleMap) {
    for (const [k, v] of Object.entries(options.groupRoleMap)) {
      const cleanKey = k.replace(/^\/+/, '');
      if (typeof v === 'string') {
        const role = normalizeRole(v);
        if (role) normalizedMap.set(cleanKey, { org: defaultTenantSlug, role });
      } else if (v && typeof v === 'object' && v.role) {
        const role = normalizeRole(v.role);
        if (role) {
          normalizedMap.set(cleanKey, { org: v.org || defaultTenantSlug, role });
        }
      }
    }
  }

  const grants = new Map<string, GroupRole>();
  const ignored: string[] = [];

  for (const rawGroup of groups) {
    if (typeof rawGroup !== 'string') continue;
    const group = rawGroup.replace(/^\/+/, '');

    // 1. Check explicit groupRoleMap first
    if (normalizedMap.has(group)) {
      const entry = normalizedMap.get(group)!;
      const current = grants.get(entry.org);
      if (!current || ROLE_RANK[entry.role] > ROLE_RANK[current]) {
        grants.set(entry.org, entry.role);
      }
      continue;
    }

    // 2. Convention-based parsing: must start with prefix
    if (!group.startsWith(cleanPrefix)) {
      continue;
    }

    const remainder = group.slice(cleanPrefix.length);
    if (!remainder) {
      ignored.push(rawGroup);
      continue;
    }

    const parts = remainder.split('/');
    if (parts.length === 1) {
      const slug = parts[0];
      if (!slug) {
        ignored.push(rawGroup);
        continue;
      }
      const role: GroupRole = 'viewer';
      const current = grants.get(slug);
      if (!current || ROLE_RANK[role] > ROLE_RANK[current]) {
        grants.set(slug, role);
      }
      continue;
    }

    if (parts.length === 2) {
      const [slug, suffix] = parts;
      if (!slug || !suffix) {
        ignored.push(rawGroup);
        continue;
      }

      // Check if suffix matches <app>-<role>
      let matchedApp = false;
      let matchedRole: GroupRole | undefined;

      for (const app of apps) {
        const appPrefix = `${app}-`;
        if (suffix.toLowerCase().startsWith(appPrefix)) {
          matchedApp = true;
          const roleStr = suffix.slice(appPrefix.length);
          matchedRole = normalizeRole(roleStr);
          break;
        }
      }

      if (matchedApp) {
        if (matchedRole) {
          const current = grants.get(slug);
          if (!current || ROLE_RANK[matchedRole] > ROLE_RANK[current]) {
            grants.set(slug, matchedRole);
          }
        } else {
          // Group explicitly targeted this app, but named an invalid role
          ignored.push(rawGroup);
        }
        continue;
      }

      // If suffix contains a hyphen, it's scoped to another app (e.g. tavaranpaikka-keeper):
      // silently skip.
      if (suffix.includes('-')) {
        continue;
      }

      // Otherwise check if suffix directly names a role (for backwards compatibility with prefix "ptv/")
      const directRole = normalizeRole(suffix);
      if (directRole) {
        const current = grants.get(slug);
        if (!current || ROLE_RANK[directRole] > ROLE_RANK[current]) {
          grants.set(slug, directRole);
        }
      } else {
        ignored.push(rawGroup);
      }
      continue;
    }

    // More than 2 segments (e.g. parish/riihimaki/ptv/publisher or parish/a/b/c)
    ignored.push(rawGroup);
  }

  return { grants, ignored };
}

/** The groups claim's value: a list of names, or a single name. Anything else is no groups. */
export function groupsFromClaim(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return undefined;
}

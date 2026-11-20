import { describe, expect, it } from 'vitest';
import { loadOidcConfig } from '../config.js';
import { groupsFromClaim, parseGroupGrants } from './groupGrants.js';

const BASE_ENV = {
  OIDC_ISSUER: 'https://idp.example.test/realms/main',
  OIDC_CLIENT_ID: 'ptv-mcp',
};

describe('OIDC_GROUP_SYNC configuration', () => {
  it('is off by default', () => {
    expect(loadOidcConfig({ ...BASE_ENV }, 'development')?.groupSync).toBeUndefined();
  });

  it('is off when set to false', () => {
    const config = loadOidcConfig({ ...BASE_ENV, OIDC_GROUP_SYNC: 'false' }, 'development');
    expect(config?.groupSync).toBeUndefined();
  });

  it('uses the groups claim and the parish/ prefix by default', () => {
    const config = loadOidcConfig({ ...BASE_ENV, OIDC_GROUP_SYNC: 'true' }, 'development');
    expect(config?.groupSync).toEqual({
      claim: 'groups',
      prefix: 'parish/',
      apps: ['ptv', 'ptv-mcp'],
      defaultTenantSlug: 'riihimaki',
    });
  });

  it('takes the claim and prefix from the environment and ends the prefix with a slash', () => {
    const config = loadOidcConfig(
      {
        ...BASE_ENV,
        OIDC_GROUP_SYNC: '1',
        OIDC_GROUPS_CLAIM: 'roles',
        OIDC_GROUP_PREFIX: 'org',
        OIDC_GROUP_APP: 'custom-app',
        DEFAULT_TENANT_SLUG: 'custom-tenant',
      },
      'development',
    );
    expect(config?.groupSync).toEqual({
      claim: 'roles',
      prefix: 'org/',
      apps: ['custom-app'],
      defaultTenantSlug: 'custom-tenant',
    });
  });

  it('enables group sync when OIDC_GROUP_ROLE_MAP is provided even without OIDC_GROUP_SYNC=true', () => {
    const map = JSON.stringify({ 'parish/riihimaki': 'viewer' });
    const config = loadOidcConfig(
      { ...BASE_ENV, OIDC_GROUP_ROLE_MAP: map },
      'development',
    );
    expect(config?.groupSync).toBeDefined();
    expect(config?.groupSync?.groupRoleMap).toEqual({ 'parish/riihimaki': 'viewer' });
  });

  it('refuses invalid JSON in OIDC_GROUP_ROLE_MAP', () => {
    expect(() =>
      loadOidcConfig(
        { ...BASE_ENV, OIDC_GROUP_ROLE_MAP: 'not json' },
        'development',
      ),
    ).toThrow(/OIDC_GROUP_ROLE_MAP/);
  });

  it('refuses a prefix with whitespace', () => {
    expect(() =>
      loadOidcConfig(
        { ...BASE_ENV, OIDC_GROUP_SYNC: 'true', OIDC_GROUP_PREFIX: 'bad prefix/' },
        'development',
      ),
    ).toThrow(/OIDC_GROUP_PREFIX/);
  });

  it('refuses a flag that is not a boolean', () => {
    expect(() => loadOidcConfig({ ...BASE_ENV, OIDC_GROUP_SYNC: 'maybe' }, 'development')).toThrow(
      /OIDC_GROUP_SYNC/,
    );
  });
});

describe('parseGroupGrants', () => {
  describe('Tavaranpaikka structure: parish/<tenant-slug>[/<app>-<role>]', () => {
    const prefix = 'parish/';

    it('grants Viewer for a bare tenant group and the named role for app-scoped groups', () => {
      const { grants, ignored } = parseGroupGrants(
        [
          'parish/riihimaki',
          'parish/beta/ptv-contributor',
          'parish/gamma/ptv-mcp-approver',
          'parish/delta/ptv-publisher',
          'parish/epsilon/ptv-admin',
          'parish/zeta/ptv-mcp-tenant_admin',
        ],
        prefix,
      );
      expect(grants).toEqual(
        new Map([
          ['riihimaki', 'viewer'],
          ['beta', 'contributor'],
          ['gamma', 'approver'],
          ['delta', 'publisher'],
          ['epsilon', 'tenant_admin'],
          ['zeta', 'tenant_admin'],
        ]),
      );
      expect(ignored).toEqual([]);
    });

    it('normalizes leading slashes in group names', () => {
      const { grants, ignored } = parseGroupGrants(
        ['/parish/riihimaki', '/parish/riihimaki/ptv-publisher'],
        prefix,
      );
      expect(grants.get('riihimaki')).toBe('publisher');
      expect(ignored).toEqual([]);
    });

    it('keeps the highest role when several groups name one tenant', () => {
      const { grants } = parseGroupGrants(
        [
          'parish/riihimaki',
          'parish/riihimaki/ptv-contributor',
          'parish/riihimaki/ptv-publisher',
        ],
        prefix,
      );
      expect(grants.get('riihimaki')).toBe('publisher');
    });

    it('silently ignores other apps groups under the parish structure', () => {
      const { grants, ignored } = parseGroupGrants(
        [
          'parish/riihimaki',
          'parish/riihimaki/tavaranpaikka-keeper',
          'parish/riihimaki/tavaranpaikka-admin',
          'parish/riihimaki/keskuskirkko-editor',
          'parish/riihimaki/ptv-publisher',
        ],
        prefix,
      );
      expect(grants.get('riihimaki')).toBe('publisher');
      expect(ignored).toEqual([]);
    });

    it('reports malformed groups under this app namespace', () => {
      const { grants, ignored } = parseGroupGrants(
        ['parish/', 'parish/riihimaki/', 'parish/riihimaki/ptv-invalidrole', 'parish/a/b/c'],
        prefix,
      );
      expect(grants.size).toBe(0);
      expect(ignored).toEqual([
        'parish/',
        'parish/riihimaki/',
        'parish/riihimaki/ptv-invalidrole',
        'parish/a/b/c',
      ]);
    });

    it('ignores groups outside the prefix without reporting them', () => {
      const { grants, ignored } = parseGroupGrants(['other/alpha/ptv-publisher', 'staff'], prefix);
      expect(grants.size).toBe(0);
      expect(ignored).toEqual([]);
    });
  });

  describe('explicit OIDC_GROUP_ROLE_MAP (Tavaranpaikka compatibility)', () => {
    it('supports direct mapping by group name', () => {
      const groupRoleMap = {
        'parish/riihimaki': 'viewer',
        'parish/riihimaki/ptv-keeper': 'contributor',
        'parish/riihimaki/ptv-admin': 'tenant_admin',
        'parish/hyvinkaa': { org: 'hyvinkaa', role: 'viewer' },
        'parish/hyvinkaa/ptv-publisher': { org: 'hyvinkaa', role: 'publisher' },
      };

      const { grants, ignored } = parseGroupGrants(
        [
          '/parish/riihimaki',
          'parish/riihimaki/ptv-admin',
          'parish/hyvinkaa/ptv-publisher',
        ],
        { groupRoleMap, defaultTenantSlug: 'riihimaki' },
      );

      expect(grants).toEqual(
        new Map([
          ['riihimaki', 'tenant_admin'],
          ['hyvinkaa', 'publisher'],
        ]),
      );
      expect(ignored).toEqual([]);
    });
  });

  describe('backwards compatibility with prefix ptv/', () => {
    const prefix = 'ptv/';

    it('grants roles when groups directly specify role under ptv/ prefix', () => {
      const { grants, ignored } = parseGroupGrants(
        ['ptv/alpha', 'ptv/beta/contributor', 'ptv/gamma/approver', 'ptv/delta/publisher'],
        prefix,
      );
      expect(grants).toEqual(
        new Map([
          ['alpha', 'viewer'],
          ['beta', 'contributor'],
          ['gamma', 'approver'],
          ['delta', 'publisher'],
        ]),
      );
      expect(ignored).toEqual([]);
    });
  });
});

describe('groupsFromClaim', () => {
  it('reads a list of strings and drops other entries', () => {
    expect(groupsFromClaim(['ptv/a', 3, 'ptv/b'])).toEqual(['ptv/a', 'ptv/b']);
  });

  it('reads a single string as one group', () => {
    expect(groupsFromClaim('ptv/a')).toEqual(['ptv/a']);
    expect(groupsFromClaim('')).toEqual([]);
  });

  it('treats a missing or unusable claim as undefined', () => {
    expect(groupsFromClaim(undefined)).toBeUndefined();
    expect(groupsFromClaim({ ptv: 'a' })).toBeUndefined();
  });
});

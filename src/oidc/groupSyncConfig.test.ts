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

  it('uses the groups claim and the ptv/ prefix by default', () => {
    const config = loadOidcConfig({ ...BASE_ENV, OIDC_GROUP_SYNC: 'true' }, 'development');
    expect(config?.groupSync).toEqual({ claim: 'groups', prefix: 'ptv/' });
  });

  it('takes the claim and prefix from the environment and ends the prefix with a slash', () => {
    const config = loadOidcConfig(
      { ...BASE_ENV, OIDC_GROUP_SYNC: '1', OIDC_GROUPS_CLAIM: 'roles', OIDC_GROUP_PREFIX: 'org' },
      'development',
    );
    expect(config?.groupSync).toEqual({ claim: 'roles', prefix: 'org/' });
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
  const prefix = 'ptv/';

  it('grants Viewer for a bare tenant group and the named role otherwise', () => {
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

  it('keeps the highest role when several groups name one tenant', () => {
    const { grants } = parseGroupGrants(
      ['ptv/alpha/publisher', 'ptv/alpha', 'ptv/alpha/contributor'],
      prefix,
    );
    expect(grants.get('alpha')).toBe('publisher');
  });

  it('never grants Tenant Admin from a group and reports it as ignored', () => {
    const { grants, ignored } = parseGroupGrants(['ptv/alpha/tenant_admin'], prefix);
    expect(grants.size).toBe(0);
    expect(ignored).toEqual(['ptv/alpha/tenant_admin']);
  });

  it('ignores groups outside the prefix without reporting them', () => {
    const { grants, ignored } = parseGroupGrants(['other/alpha/publisher', 'staff'], prefix);
    expect(grants.size).toBe(0);
    expect(ignored).toEqual([]);
  });

  it('reports malformed groups under the prefix', () => {
    const { grants, ignored } = parseGroupGrants(['ptv/', 'ptv/a/b/c', 'ptv/alpha/'], prefix);
    expect(grants.size).toBe(0);
    expect(ignored).toEqual(['ptv/', 'ptv/a/b/c', 'ptv/alpha/']);
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

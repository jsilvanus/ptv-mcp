import { describe, expect, it } from 'vitest';
import { loadConfig, loadOidcConfig, normalizeDomainPath } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/test',
  MASTER_ENCRYPTION_KEY: 'key',
  JWT_SECRET: Buffer.alloc(32, 7).toString('base64'),
};

describe('DOMAIN_PATH config', () => {
  it('defaults to root for an unset, empty or slash value', () => {
    expect(loadConfig({ ...base }).domainPath).toBe('');
    expect(loadConfig({ ...base, DOMAIN_PATH: '' }).domainPath).toBe('');
    expect(loadConfig({ ...base, DOMAIN_PATH: '/' }).domainPath).toBe('');
  });

  it('normalizes a non-root prefix and a trailing slash', () => {
    expect(normalizeDomainPath('/ptv-mcp')).toBe('/ptv-mcp');
    expect(normalizeDomainPath('/ptv-mcp/')).toBe('/ptv-mcp');
    expect(loadConfig({ ...base, DOMAIN_PATH: '/ptv-mcp' }).domainPath).toBe('/ptv-mcp');
  });

  it.each(['ptv-mcp', '//ptv-mcp', '/ptv//mcp', '/ptv/../mcp', '/ptv?x=1', '/ptv#m', '/ptv\\mcp'])(
    'rejects unsafe path %s',
    (value) => {
      expect(() => normalizeDomainPath(value)).toThrow('Invalid DOMAIN_PATH');
    },
  );
});

describe('JWT_SECRET config', () => {
  it('refuses a secret that decodes to under 32 bytes', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'secret' })).toThrow('at least 32 bytes');
    expect(() => loadConfig({ ...base, JWT_SECRET: Buffer.alloc(31).toString('base64') })).toThrow(
      'at least 32 bytes',
    );
  });

  it('accepts 32 bytes', () => {
    expect(loadConfig({ ...base }).jwtSecret).toBe(base.JWT_SECRET);
  });
});

describe('ALLOW_PRIVILEGED_DB_ROLE config', () => {
  it('defaults to false and reads true', () => {
    expect(loadConfig({ ...base }).allowPrivilegedDbRole).toBe(false);
    expect(loadConfig({ ...base, ALLOW_PRIVILEGED_DB_ROLE: 'true' }).allowPrivilegedDbRole).toBe(
      true,
    );
  });
});

describe('REQUIRE_VERIFIED_EMAIL config', () => {
  it('defaults to false when unset or empty', () => {
    expect(loadConfig({ ...base }).requireVerifiedEmail).toBe(false);
    expect(loadConfig({ ...base, REQUIRE_VERIFIED_EMAIL: '' }).requireVerifiedEmail).toBe(false);
  });

  it('reads true and false', () => {
    expect(loadConfig({ ...base, REQUIRE_VERIFIED_EMAIL: 'true' }).requireVerifiedEmail).toBe(true);
    expect(loadConfig({ ...base, REQUIRE_VERIFIED_EMAIL: 'FALSE' }).requireVerifiedEmail).toBe(
      false,
    );
  });

  it('refuses a value that is not a boolean', () => {
    expect(() => loadConfig({ ...base, REQUIRE_VERIFIED_EMAIL: 'yes' })).toThrow(
      'Invalid REQUIRE_VERIFIED_EMAIL',
    );
  });
});

describe('OIDC config', () => {
  it('is off when OIDC_ISSUER is unset or empty', () => {
    expect(loadConfig({ ...base }).oidc).toBeUndefined();
    expect(loadConfig({ ...base, OIDC_ISSUER: '' }).oidc).toBeUndefined();
    expect(loadConfig({ ...base, OIDC_ISSUER: '  ', OIDC_CLIENT_ID: '' }).oidc).toBeUndefined();
  });

  it('applies defaults', () => {
    expect(
      loadConfig({
        ...base,
        OIDC_ISSUER: 'https://auth.example.org/application/o/ptv/',
        OIDC_CLIENT_ID: 'client',
      }).oidc,
    ).toEqual({
      issuer: 'https://auth.example.org/application/o/ptv/',
      clientId: 'client',
      scopes: 'openid email profile',
      buttonLabel: 'Sign in with single sign-on',
      createUsers: false,
      trustEmail: false,
    });
  });

  it('reads every variable', () => {
    expect(
      loadOidcConfig(
        {
          OIDC_ISSUER: 'https://auth.example.org/application/o/ptv/',
          OIDC_CLIENT_ID: 'client',
          OIDC_CLIENT_SECRET: 'shh',
          OIDC_SCOPES: 'openid  email',
          OIDC_BUTTON_LABEL: 'Kirjaudu kertakirjautumisella',
          OIDC_CREATE_USERS: 'true',
          OIDC_TRUST_EMAIL: 'TRUE',
        },
        'production',
      ),
    ).toEqual({
      issuer: 'https://auth.example.org/application/o/ptv/',
      clientId: 'client',
      clientSecret: 'shh',
      scopes: 'openid email',
      buttonLabel: 'Kirjaudu kertakirjautumisella',
      createUsers: true,
      trustEmail: true,
    });
  });

  it.each([
    [{ OIDC_ISSUER: 'https://auth.example.org/' }, 'OIDC_CLIENT_ID is required'],
    [{ OIDC_ISSUER: 'not a url', OIDC_CLIENT_ID: 'c' }, 'not an absolute URL'],
    [{ OIDC_ISSUER: 'ftp://auth.example.org/', OIDC_CLIENT_ID: 'c' }, 'http(s) URL'],
    [
      { OIDC_ISSUER: 'https://auth.example.org/', OIDC_CLIENT_ID: 'c', OIDC_SCOPES: 'email' },
      'must include openid',
    ],
    [
      { OIDC_ISSUER: 'https://auth.example.org/', OIDC_CLIENT_ID: 'c', OIDC_CREATE_USERS: 'yes' },
      'Invalid OIDC_CREATE_USERS',
    ],
    [
      { OIDC_ISSUER: 'https://auth.example.org/', OIDC_CLIENT_ID: 'c', OIDC_TRUST_EMAIL: 'maybe' },
      'Invalid OIDC_TRUST_EMAIL',
    ],
  ])('refuses %j', (env, message) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(message);
  });

  it('requires https in production only', () => {
    const env = { OIDC_ISSUER: 'http://127.0.0.1:9000/', OIDC_CLIENT_ID: 'c' };
    expect(() => loadOidcConfig(env, 'production')).toThrow('https is required in production');
    expect(loadOidcConfig(env, 'development')?.issuer).toBe('http://127.0.0.1:9000/');
  });

  it('reads OIDC_POST_LOGOUT_REDIRECT_URI and leaves it unset by default', () => {
    const base = { OIDC_ISSUER: 'https://auth.example.org/', OIDC_CLIENT_ID: 'c' };
    expect(loadOidcConfig(base, 'production')?.postLogoutRedirectUri).toBeUndefined();
    expect(
      loadOidcConfig(
        { ...base, OIDC_POST_LOGOUT_REDIRECT_URI: ' https://ptv.example.org/login ' },
        'production',
      )?.postLogoutRedirectUri,
    ).toBe('https://ptv.example.org/login');
  });

  it.each([
    ['not-a-url', 'not an absolute URL'],
    ['javascript:alert(1)', 'must be an http(s) URL'],
  ])('refuses OIDC_POST_LOGOUT_REDIRECT_URI %s', (value, message) => {
    const env = {
      OIDC_ISSUER: 'https://auth.example.org/',
      OIDC_CLIENT_ID: 'c',
      OIDC_POST_LOGOUT_REDIRECT_URI: value,
    };
    expect(() => loadOidcConfig(env, 'development')).toThrow(message);
  });

  it('requires https for OIDC_POST_LOGOUT_REDIRECT_URI in production', () => {
    const env = {
      OIDC_ISSUER: 'https://auth.example.org/',
      OIDC_CLIENT_ID: 'c',
      OIDC_POST_LOGOUT_REDIRECT_URI: 'http://ptv.example.org/login',
    };
    expect(() => loadOidcConfig(env, 'production')).toThrow('https is required in production');
  });
});

describe('AUTH_MODE config', () => {
  const oidcEnv = { OIDC_ISSUER: 'https://idp.example.test/', OIDC_CLIENT_ID: 'ptv-mcp' };

  it('defaults to local without OIDC and to both with OIDC', () => {
    expect(loadConfig({ ...base }).authMode).toBe('local');
    expect(loadConfig({ ...base, ...oidcEnv }).authMode).toBe('both');
  });

  it('accepts oidc with OIDC configured, ignoring case and spaces', () => {
    expect(loadConfig({ ...base, ...oidcEnv, AUTH_MODE: ' OIDC ' }).authMode).toBe('oidc');
  });

  it('refuses an unknown mode', () => {
    expect(() => loadConfig({ ...base, ...oidcEnv, AUTH_MODE: 'sso' })).toThrow(
      'Invalid AUTH_MODE',
    );
  });

  it('refuses oidc or both without OIDC_ISSUER', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'oidc' })).toThrow('OIDC_ISSUER must be set');
    expect(() => loadConfig({ ...base, AUTH_MODE: 'both' })).toThrow('OIDC_ISSUER must be set');
  });

  it('refuses local while OIDC is configured', () => {
    expect(() => loadConfig({ ...base, ...oidcEnv, AUTH_MODE: 'local' })).toThrow(
      'Invalid AUTH_MODE=local',
    );
  });

  it('parses break-glass emails: lowercased, trimmed, de-duplicated', () => {
    expect(loadConfig({ ...base }).breakGlassEmails).toEqual([]);
    expect(
      loadConfig({
        ...base,
        OIDC_BREAK_GLASS_EMAILS: ' Admin@Example.test, ops@example.test ,admin@example.TEST,,',
      }).breakGlassEmails,
    ).toEqual(['admin@example.test', 'ops@example.test']);
  });
});

describe('ALLOW_TENANT_CREATION config', () => {
  it('defaults to true, so POST /tenants keeps working unchanged', () => {
    expect(loadConfig({ ...base }).allowTenantCreation).toBe(true);
  });

  it('reads false and true', () => {
    expect(loadConfig({ ...base, ALLOW_TENANT_CREATION: 'false' }).allowTenantCreation).toBe(false);
    expect(loadConfig({ ...base, ALLOW_TENANT_CREATION: 'true' }).allowTenantCreation).toBe(true);
  });

  it('refuses a value that is neither true nor false', () => {
    expect(() => loadConfig({ ...base, ALLOW_TENANT_CREATION: 'no' })).toThrow(
      'Invalid ALLOW_TENANT_CREATION',
    );
  });
});

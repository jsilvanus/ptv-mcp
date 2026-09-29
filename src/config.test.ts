import { describe, expect, it } from 'vitest';
import { loadConfig, loadOidcConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/test',
  MASTER_ENCRYPTION_KEY: 'key',
  JWT_SECRET: 'secret',
};

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
});

import { describe, expect, it } from 'vitest';
import {
  fetchV11ApiToken,
  jwtExpiry,
  parseV11ApiUserCredentials,
  V11ApiLoginError,
  V11ApiTokenCache,
} from './apiLogin.js';
import { PtvV11Client } from '../client.js';

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchV11ApiToken', () => {
  it('logs in to the test environment without apiUserOrganisation and reads ptvToken', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const token = jwt(2_000);
    const result = await fetchV11ApiToken(
      'test',
      { username: 'API1@testi.fi', password: 'pw', apiUserOrganisation: 'ignored' },
      {
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return json({ ptvToken: token });
        },
      },
    );
    expect(calls).toEqual([
      {
        url: 'https://palvelutietovaranto.trn.suomi.fi/api/auth/api-login',
        body: { username: 'API1@testi.fi', password: 'pw' },
      },
    ]);
    expect(result).toEqual({ token, expiresAt: 2_000_000 });
  });

  it('logs in to production with apiUserOrganisation and reads serviceToken', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const result = await fetchV11ApiToken(
      'production',
      { username: 'u', password: 'p', apiUserOrganisation: 'org-1' },
      {
        now: () => 1_000,
        fetchImpl: async (input, init) => {
          seen = { url: String(input), body: JSON.parse(String(init?.body)) };
          return json({ serviceToken: 'opaque' });
        },
      },
    );
    expect(seen).toEqual({
      url: 'https://palveluhallinta.suomi.fi/api/auth/api-login',
      body: { username: 'u', password: 'p', apiUserOrganisation: 'org-1' },
    });
    // No readable exp: falls back to 30 minutes.
    expect(result).toEqual({ token: 'opaque', expiresAt: 1_000 + 30 * 60 * 1000 });
  });

  it('rejects without echoing the response body', async () => {
    const error = await fetchV11ApiToken(
      'test',
      { username: 'u', password: 'secret' },
      { fetchImpl: async () => new Response('bad password for u / secret', { status: 400 }) },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(V11ApiLoginError);
    expect((error as V11ApiLoginError).status).toBe(400);
    expect((error as Error).message).not.toContain('secret');
  });

  it('fails when no token is returned', async () => {
    await expect(
      fetchV11ApiToken(
        'test',
        { username: 'u', password: 'p' },
        { fetchImpl: async () => json({}) },
      ),
    ).rejects.toThrow(/no token/);
  });
});

describe('jwtExpiry / parseV11ApiUserCredentials', () => {
  it('reads exp in milliseconds and tolerates non-JWTs', () => {
    expect(jwtExpiry(jwt(5))).toBe(5_000);
    expect(jwtExpiry('opaque')).toBeUndefined();
    expect(jwtExpiry('a.!!!.b')).toBeUndefined();
  });

  it('parses only complete credentials', () => {
    expect(parseV11ApiUserCredentials({ username: 'u', password: 'p' })).toEqual({
      username: 'u',
      password: 'p',
    });
    expect(parseV11ApiUserCredentials({ apiKey: 'x' })).toBeUndefined();
    expect(parseV11ApiUserCredentials(undefined)).toBeUndefined();
  });
});

describe('V11ApiTokenCache', () => {
  it('reuses a token until shortly before expiry and shares in-flight logins', async () => {
    let now = 0;
    let logins = 0;
    const cache = new V11ApiTokenCache({
      now: () => now,
      fetchImpl: async () => {
        logins++;
        return json({ ptvToken: jwt(600 + logins) });
      },
    });
    const creds = { username: 'u', password: 'p' };
    const [a, b] = await Promise.all([
      cache.getToken('test', creds),
      cache.getToken('test', creds),
    ]);
    expect(a).toBe(b);
    expect(logins).toBe(1);

    now = 500_000; // 101 s before expiry: still fresh
    await cache.getToken('test', creds);
    expect(logins).toBe(1);
    now = 560_000; // inside the 60 s margin
    await cache.getToken('test', creds);
    expect(logins).toBe(2);

    cache.invalidate('test', creds);
    await cache.getToken('test', creds);
    expect(logins).toBe(3);
  });
});

describe('PtvV11Client with a write token provider', () => {
  function provider() {
    let n = 0;
    const state = { invalidated: 0 };
    return {
      state,
      provider: {
        getToken: async () => `t${++n}`,
        invalidate: () => {
          state.invalidated++;
        },
      },
    };
  }

  it('authenticates writes but leaves public GETs anonymous', async () => {
    const auth: Array<[string, string | null]> = [];
    const { provider: writeTokenProvider } = provider();
    const client = new PtvV11Client({
      environment: 'test',
      writeTokenProvider,
      fetchImpl: async (_input, init) => {
        auth.push([String(init?.method), new Headers(init?.headers).get('Authorization')]);
        return json({ id: 's1' });
      },
    });
    await client.get('/api/v11/Service/s1');
    await client.put('/api/v11/Service/s1', {});
    expect(auth).toEqual([
      ['GET', null],
      ['PUT', 'Bearer t1'],
    ]);
  });

  it('logs in again once on 401, then gives up', async () => {
    const { provider: writeTokenProvider, state } = provider();
    const seen: string[] = [];
    const client = new PtvV11Client({
      environment: 'test',
      writeTokenProvider,
      maxRetries: 0,
      fetchImpl: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('Authorization') ?? '');
        return seen.length === 1 ? new Response('', { status: 401 }) : json({ id: 's1' });
      },
    });
    await expect(client.put('/api/v11/Service/s1', {})).resolves.toEqual({ id: 's1' });
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
    expect(state.invalidated).toBe(1);

    const always401 = new PtvV11Client({
      environment: 'test',
      writeTokenProvider,
      maxRetries: 0,
      fetchImpl: async () => new Response('', { status: 401 }),
    });
    await expect(always401.put('/api/v11/Service/s1', {})).rejects.toMatchObject({ status: 401 });
  });
});

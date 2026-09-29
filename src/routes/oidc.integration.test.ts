import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig, type OidcConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { oidcIdentities, refreshTokens, users } from '../db/schema/index.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { IntegrationFixtures, listenLocally } from '../testing/integrationFixtures.js';
import { FakeOidcProvider } from '../testing/fakeOidcProvider.js';
import { connectMcpClient } from '../testing/mcpClient.js';
import { OIDC_STATE_COOKIE } from './oidc.js';

const CLIENT_ID = 'ptv-mcp-test';
const CLIENT_SECRET = 'test-secret';
const MCP_REDIRECT_URI = 'https://mcp-client.example.test/callback';

describe('OIDC sign-in', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const fixtures = new IntegrationFixtures(db, config);
  const idp = new FakeOidcProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const apps: FastifyInstance[] = [];
  const createdEmails: string[] = [];
  let mcpClientId: string;

  function oidcConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
    return {
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: 'openid email profile',
      buttonLabel: 'Sign in with single sign-on',
      createUsers: false,
      trustEmail: false,
      ...overrides,
    };
  }

  async function app(oidc: OidcConfig | null = oidcConfig()): Promise<FastifyInstance> {
    const base = { ...config };
    delete base.oidc;
    const instance = await buildApp({
      config: { ...base, logLevel: 'silent', ...(oidc ? { oidc } : {}) },
      db,
    });
    apps.push(instance);
    return instance;
  }

  beforeAll(async () => {
    await idp.start();
    const defaultApp = await app();
    const registered = await defaultApp.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'OIDC test client', redirect_uris: [MCP_REDIRECT_URI] },
    });
    mcpClientId = (registered.json() as { client_id: string }).client_id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM oauth_clients WHERE client_id = ${mcpClientId}`);
    for (const instance of apps) await instance.close();
    await idp.stop();
  });

  afterEach(async () => {
    for (const email of createdEmails.splice(0)) {
      await db.delete(users).where(eq(users.email, email));
    }
    await fixtures.cleanup();
  });

  /** A user whose email the tests control (fixtures.user's email is `${id}@example.test`). */
  async function localUser(): Promise<{ userId: string; email: string }> {
    const userId = await fixtures.user('Local User');
    return { userId, email: `${userId}@example.test` };
  }

  function stateCookie(setCookie: string | string[] | undefined): string {
    const header = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    const match = new RegExp(`${OIDC_STATE_COOKIE}=([^;]*)`).exec(header);
    if (!match?.[1]) throw new Error('No OIDC state cookie set');
    return match[1];
  }

  /** Starts a sign-in on `instance`, lets the fake IdP answer, and returns the callback request. */
  async function signInAtIdp(instance: FastifyInstance, loginUrl = '/oidc/login') {
    const start = await instance.inject({ method: 'GET', url: loginUrl });
    expect(start.statusCode).toBe(302);
    const cookie = stateCookie(start.headers['set-cookie']);
    expect(String(start.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(start.headers['set-cookie'])).toMatch(/SameSite=Lax/);
    expect(String(start.headers['set-cookie'])).toMatch(/Path=\/oidc/);
    const atIdp = await fetch(String(start.headers.location), { redirect: 'manual' });
    expect(atIdp.status).toBe(302);
    const callback = new URL(atIdp.headers.get('location') ?? '');
    expect(callback.pathname).toBe('/oidc/callback');
    return { callbackPath: callback.pathname + callback.search, cookie };
  }

  function callback(instance: FastifyInstance, callbackPath: string, cookie: string) {
    return instance.inject({
      method: 'GET',
      url: callbackPath,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${cookie}` },
    });
  }

  /** The full web-UI sign-in; returns the callback response. */
  async function webSignIn(instance: FastifyInstance) {
    const { callbackPath, cookie } = await signInAtIdp(instance);
    return callback(instance, callbackPath, cookie);
  }

  function handoffCode(location: string | undefined): string {
    const match = /^\/login#oidc=(.+)$/.exec(location ?? '');
    if (!match?.[1]) throw new Error(`Unexpected redirect ${location}`);
    return decodeURIComponent(match[1]);
  }

  describe('when OIDC_ISSUER is unset', () => {
    it('shows no SSO button and serves no /oidc routes', async () => {
      const instance = await app(null);
      const page = await instance.inject({
        method: 'GET',
        url: `/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: mcpClientId,
          redirect_uri: MCP_REDIRECT_URI,
          code_challenge: 'x',
          code_challenge_method: 'S256',
        }).toString()}`,
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('/oidc/login');
      expect(page.body).toContain('name="password"');
      for (const url of ['/oidc/login', '/oidc/config', '/oidc/callback']) {
        expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      const metadata = await instance.inject({
        method: 'GET',
        url: '/.well-known/openid-configuration',
      });
      expect(metadata.body).not.toMatch(/oidc|jwks_uri|userinfo/);
    });
  });

  it('serves the button label for the web UI', async () => {
    const instance = await app(oidcConfig({ buttonLabel: 'Kirjaudu' }));
    const res = await instance.inject({ method: 'GET', url: '/oidc/config' });
    expect(res.json()).toEqual({ buttonLabel: 'Kirjaudu' });
  });

  it('signs a linked user in to the web UI with the same session a password login creates', async () => {
    const instance = await app();
    const { userId } = await localUser();
    const subject = randomUUID();
    await db.insert(oidcIdentities).values({ issuer: idp.issuer, subject, userId });
    idp.user = { sub: subject, email: 'someone-else@example.test', email_verified: true };

    const res = await webSignIn(instance);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['set-cookie'])).toMatch(
      new RegExp(`${OIDC_STATE_COOKIE}=;.*Max-Age=0`),
    );
    // PKCE and nonce were sent to the IdP.
    expect(idp.lastAuthorizeParams?.get('code_challenge_method')).toBe('S256');
    expect(idp.lastAuthorizeParams?.get('nonce')).toBeTruthy();
    expect(idp.lastAuthorizeParams?.get('scope')).toBe('openid email profile');

    const code = handoffCode(res.headers.location);
    const session = await instance.inject({
      method: 'POST',
      url: '/oidc/session',
      payload: { code },
    });
    expect(session.statusCode).toBe(200);
    const body = session.json() as { accessToken: string; refreshToken: string };
    expect((await verifyAccessToken(body.accessToken, config.jwtSecret)).sub).toBe(userId);
    // The session works on the REST API and can be refreshed like any other.
    const tenants = await instance.inject({
      method: 'GET',
      url: '/tenants',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(tenants.statusCode).toBe(200);
    const refreshed = await instance.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: body.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);

    // The handoff code is single use.
    const again = await instance.inject({
      method: 'POST',
      url: '/oidc/session',
      payload: { code },
    });
    expect(again.statusCode).toBe(401);

    const [identity] = await db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, subject));
    expect(identity?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('completes an MCP authorization via OIDC, ending with a token that works on /mcp', async () => {
    const instance = await app();
    const { userId, email } = await localUser();
    idp.user = { sub: randomUUID(), email, email_verified: true };

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const page = await instance.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: mcpClientId,
        redirect_uri: MCP_REDIRECT_URI,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'client-state',
      }).toString()}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Sign in with single sign-on');
    expect(page.body).toContain('name="password"');
    const ssoHref = /href="(\/oidc\/login\?oauth=[^"]+)"/.exec(page.body)?.[1];
    expect(ssoHref).toBeDefined();

    const { callbackPath, cookie } = await signInAtIdp(instance, ssoHref!);
    const selection = await callback(instance, callbackPath, cookie);
    expect(selection.statusCode).toBe(200);
    expect(selection.body).toContain('Choose PTV connection');
    const selectionToken = /name="selection_token" value="([^"]+)"/.exec(selection.body)?.[1];
    expect(selectionToken).toBeDefined();

    const approved = await instance.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        selection_token: selectionToken!,
        tenant_id: '',
        environment: 'test',
        read_api_version: 'v11',
        write_api_version: '',
      }).toString(),
    });
    expect(approved.statusCode).toBe(302);
    const redirect = new URL(String(approved.headers.location));
    expect(redirect.origin + redirect.pathname).toBe(MCP_REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('client-state');

    const token = await instance.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        client_id: mcpClientId,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const accessToken = (token.json() as { access_token: string }).access_token;
    expect((await fixtures.oauth.verifyAccessToken(accessToken)).sub).toBe(userId);

    const listening = await app();
    const baseUrl = await listenLocally(listening);
    const client = await connectMcpClient(baseUrl, accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('ptv_search_services');
    await client.close();

    // Like the password path, the OAuth sign-in opened no web-UI session.
    const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('re-validates the pending authorization request on /oidc/login', async () => {
    const instance = await app();
    const bogus = Buffer.from(
      new URLSearchParams({
        client_id: mcpClientId,
        redirect_uri: 'https://attacker.example.test/cb',
        code_challenge: 'x',
        code_challenge_method: 'S256',
      }).toString(),
    ).toString('base64url');
    const res = await instance.inject({ method: 'GET', url: `/oidc/login?oauth=${bogus}` });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    const instance = await app();
    const { userId } = await localUser();
    const subject = randomUUID();
    await db.insert(oidcIdentities).values({ issuer: idp.issuer, subject, userId });
    idp.user = { sub: subject };

    const { callbackPath } = await signInAtIdp(instance);
    const other = await signInAtIdp(instance);
    const res = await callback(instance, callbackPath, other.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('not valid in this browser');
    const noCookie = await instance.inject({ method: 'GET', url: callbackPath });
    expect(noCookie.statusCode).toBe(400);
  });

  it('refuses a replayed state', async () => {
    const instance = await app();
    const { userId } = await localUser();
    const subject = randomUUID();
    await db.insert(oidcIdentities).values({ issuer: idp.issuer, subject, userId });
    idp.user = { sub: subject };

    const { callbackPath, cookie } = await signInAtIdp(instance);
    expect((await callback(instance, callbackPath, cookie)).statusCode).toBe(302);
    const replay = await callback(instance, callbackPath, cookie);
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('expired or was already used');
  });

  it('shows an error page when the IdP answers with an error', async () => {
    const instance = await app();
    const start = await instance.inject({ method: 'GET', url: '/oidc/login' });
    const cookie = stateCookie(start.headers['set-cookie']);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const res = await callback(
      instance,
      `/oidc/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('did not complete the sign-in');
    expect(res.body).toContain('href="/login"');
  });

  it('links an existing account by verified email only', async () => {
    const instance = await app();
    const { userId, email } = await localUser();

    idp.user = { sub: randomUUID(), email, email_verified: false };
    const unverified = await webSignIn(instance);
    expect(unverified.statusCode).toBe(403);
    expect(unverified.body).toContain('No account for this sign-in; ask the administrator.');

    const subject = randomUUID();
    idp.user = { sub: subject, email: email.toUpperCase(), email_verified: true };
    const verified = await webSignIn(instance);
    expect(verified.statusCode).toBe(302);
    const [identity] = await db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, subject));
    expect(identity?.userId).toBe(userId);
  });

  it('links an unverified email with OIDC_TRUST_EMAIL', async () => {
    const instance = await app(oidcConfig({ trustEmail: true }));
    const { userId, email } = await localUser();
    const subject = randomUUID();
    idp.user = { sub: subject, email, email_verified: false };
    const res = await webSignIn(instance);
    expect(res.statusCode).toBe(302);
    const [identity] = await db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, subject));
    expect(identity?.userId).toBe(userId);
  });

  it('reads the email from userinfo when the ID token has none', async () => {
    const instance = await app();
    const { userId, email } = await localUser();
    const subject = randomUUID();
    idp.user = { sub: subject, email, email_verified: true };
    idp.omitEmailFromIdToken = true;
    try {
      expect((await webSignIn(instance)).statusCode).toBe(302);
    } finally {
      idp.omitEmailFromIdToken = false;
    }
    const [identity] = await db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, subject));
    expect(identity?.userId).toBe(userId);
  });

  it('creates no account unless OIDC_CREATE_USERS is on', async () => {
    const email = `oidc-new-${randomUUID()}@example.test`;
    createdEmails.push(email);
    idp.user = { sub: randomUUID(), email, email_verified: true, name: 'New Person' };

    const off = await webSignIn(await app());
    expect(off.statusCode).toBe(403);
    expect(off.body).toContain('No account for this sign-in');
    expect(await db.query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined();

    const instance = await app(oidcConfig({ createUsers: true }));
    const on = await webSignIn(instance);
    expect(on.statusCode).toBe(302);
    const created = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(created?.name).toBe('New Person');
    expect(created?.passwordHash).toBeNull();
    expect(created?.emailVerifiedAt).toBeInstanceOf(Date);
    // No password: a password login is refused like a wrong password.
    await expect(authService.verifyCredentials(email, '')).rejects.toThrow(
      'Invalid email or password',
    );
    const session = await instance.inject({
      method: 'POST',
      url: '/oidc/session',
      payload: { code: handoffCode(on.headers.location) },
    });
    expect(session.statusCode).toBe(200);
  });

  it('does not create an account from an untrusted email', async () => {
    const email = `oidc-untrusted-${randomUUID()}@example.test`;
    createdEmails.push(email);
    idp.user = { sub: randomUUID(), email, email_verified: false };
    const res = await webSignIn(await app(oidcConfig({ createUsers: true })));
    expect(res.statusCode).toBe(403);
    expect(await db.query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined();
  });

  it('refuses a locked account like the password sign-in does', async () => {
    const instance = await app();
    const { userId } = await localUser();
    const subject = randomUUID();
    await db.insert(oidcIdentities).values({ issuer: idp.issuer, subject, userId });
    await db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(users.id, userId));
    idp.user = { sub: subject };

    const res = await webSignIn(instance);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('temporarily locked');
  });

  it('does not depend on the IdP at startup and retries a failed discovery', async () => {
    idp.down = true;
    const instance = await app();
    try {
      const failed = await instance.inject({ method: 'GET', url: '/oidc/login' });
      expect(failed.statusCode).toBe(502);
      expect(failed.body).toContain('not available right now');
    } finally {
      idp.down = false;
    }
    const retried = await instance.inject({ method: 'GET', url: '/oidc/login' });
    expect(retried.statusCode).toBe(302);
  });

  it('rate-limits sign-in starts per IP', async () => {
    const instance = await app();
    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      last = (await instance.inject({ method: 'GET', url: '/oidc/login' })).statusCode;
    }
    expect(last).toBe(429);
  });
});

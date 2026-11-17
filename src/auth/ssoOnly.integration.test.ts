import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { hashPassword } from './password.js';
import {
  AuthService,
  InvalidCredentialsError,
  PasswordRegistrationDisabledError,
} from './authService.js';
import type { Mailer } from './mailer.js';

const PASSWORD = 'correct-horse-42';
const BREAK_GLASS = 'breakglass-admin@ptv-mcp.test';
const MEMBER = 'sso-member@ptv-mcp.test';

const mailer: Mailer = {
  async sendVerificationEmail() {},
  async sendPasswordResetEmail() {},
};

describe('SSO-only mode (AUTH_MODE=oidc)', () => {
  const config = loadConfig();
  let db: Database;
  let service: AuthService;

  beforeEach(async () => {
    db = createDatabase(config.databaseUrl);
    service = new AuthService({
      db,
      jwtSecret: config.jwtSecret,
      mailer,
      authMode: 'oidc',
      breakGlassEmails: [BREAK_GLASS],
    });
    await db.delete(users).where(eq(users.email, BREAK_GLASS));
    await db.delete(users).where(eq(users.email, MEMBER));
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values([
      { email: BREAK_GLASS, name: 'Break glass', passwordHash, emailVerifiedAt: new Date() },
      { email: MEMBER, name: 'Member', passwordHash, emailVerifiedAt: new Date() },
    ]);
  });

  afterEach(async () => {
    await db.delete(users).where(eq(users.email, BREAK_GLASS));
    await db.delete(users).where(eq(users.email, MEMBER));
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('refuses a correct password for an account that is not break-glass', async () => {
    await expect(service.verifyCredentials(MEMBER, PASSWORD)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(service.login(MEMBER, PASSWORD)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('still accepts the password of a break-glass account', async () => {
    const session = await service.login(BREAK_GLASS, PASSWORD);
    expect(session.accessToken).toBeTruthy();
  });

  it('refuses self-registration', async () => {
    await expect(
      service.register('new-member@ptv-mcp.test', 'New', PASSWORD),
    ).rejects.toBeInstanceOf(PasswordRegistrationDisabledError);
  });

  it('sends no password reset to a non-break-glass account', async () => {
    const sent: string[] = [];
    const recording = new AuthService({
      db,
      jwtSecret: config.jwtSecret,
      mailer: {
        async sendVerificationEmail() {},
        async sendPasswordResetEmail(to: string) {
          sent.push(to);
        },
      },
      authMode: 'oidc',
      breakGlassEmails: [BREAK_GLASS],
    });
    await recording.requestPasswordReset(MEMBER);
    await recording.requestPasswordReset(BREAK_GLASS);
    expect(sent).toEqual([BREAK_GLASS]);
  });
});

describe('SSO-only mode over HTTP', () => {
  const config = loadConfig();
  let db: Database;
  const apps: FastifyInstance[] = [];

  beforeEach(async () => {
    db = createDatabase(config.databaseUrl);
    await db.delete(users).where(eq(users.email, BREAK_GLASS));
    await db.delete(users).where(eq(users.email, MEMBER));
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values([
      { email: BREAK_GLASS, name: 'Break glass', passwordHash, emailVerifiedAt: new Date() },
      { email: MEMBER, name: 'Member', passwordHash, emailVerifiedAt: new Date() },
    ]);
  });

  afterEach(async () => {
    for (const instance of apps.splice(0)) await instance.close();
    await db.delete(users).where(eq(users.email, BREAK_GLASS));
    await db.delete(users).where(eq(users.email, MEMBER));
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function ssoOnlyApp(): Promise<FastifyInstance> {
    const base = { ...config };
    delete base.oidc;
    const instance = await buildApp({
      config: {
        ...base,
        logLevel: 'silent',
        authMode: 'oidc',
        breakGlassEmails: [BREAK_GLASS],
        oidc: {
          issuer: 'https://idp.example.test/',
          clientId: 'ptv-mcp',
          scopes: 'openid email profile',
          buttonLabel: 'Kirjaudu',
          createUsers: false,
          trustEmail: false,
        },
      },
      db,
    });
    apps.push(instance);
    return instance;
  }

  it('reports SSO-only mode to the web UI', async () => {
    const instance = await ssoOnlyApp();
    const res = await instance.inject({ method: 'GET', url: '/oidc/config' });
    expect(res.json()).toEqual({ buttonLabel: 'Kirjaudu', ssoOnly: true });
  });

  it('refuses the password login of a member and accepts the break-glass account', async () => {
    const instance = await ssoOnlyApp();
    const member = await instance.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: MEMBER, password: PASSWORD },
    });
    expect(member.statusCode).toBe(401);

    const breakGlass = await instance.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: BREAK_GLASS, password: PASSWORD },
    });
    expect(breakGlass.statusCode).toBe(200);
  });

  it('refuses self-registration with 403', async () => {
    const instance = await ssoOnlyApp();
    const res = await instance.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new-member@ptv-mcp.test', name: 'New', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });
});

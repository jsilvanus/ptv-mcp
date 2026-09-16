import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { users } from '../db/schema/index.js';
import type { Mailer } from '../auth/mailer.js';

class CapturingMailer implements Mailer {
  verificationTokens = new Map<string, string>();
  resetTokens = new Map<string, string>();

  async sendVerificationEmail(to: string, rawToken: string): Promise<void> {
    this.verificationTokens.set(to, rawToken);
  }

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    this.resetTokens.set(to, rawToken);
  }
}

describe('auth routes', () => {
  const config = loadConfig();
  let app: FastifyInstance;
  let db: Database;
  let mailer: CapturingMailer;
  const testEmails: string[] = [];

  beforeAll(async () => {
    db = createDatabase(config.databaseUrl);
    mailer = new CapturingMailer();
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db, mailer });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    for (const email of testEmails) {
      await db.delete(users).where(eq(users.email, email));
    }
    testEmails.length = 0;
  });

  function uniqueEmail(): string {
    const email = `auth-route-${randomUUID()}@example.test`;
    testEmails.push(email);
    return email;
  }

  it('registers, logs in, refreshes, and logs out end to end', async () => {
    const email = uniqueEmail();

    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, name: 'Route Test', password: 'correct-password' },
    });
    expect(registerRes.statusCode).toBe(201);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct-password' },
    });
    expect(loginRes.statusCode).toBe(200);
    const session = loginRes.json() as { accessToken: string; refreshToken: string };
    expect(session.accessToken).toBeTruthy();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshed = refreshRes.json() as { accessToken: string; refreshToken: string };

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${refreshed.accessToken}` },
      payload: { refreshToken: refreshed.refreshToken },
    });
    expect(logoutRes.statusCode).toBe(204);

    const reuseRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: refreshed.refreshToken },
    });
    expect(reuseRes.statusCode).toBe(401);
  });

  it('rejects logout without a bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'irrelevant' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 409 for a duplicate registration', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, name: 'Route Test', password: 'password123!' },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, name: 'Route Test', password: 'password123!' },
    });
    expect(dupe.statusCode).toBe(409);
  });

  it('verifies an email via the captured token', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, name: 'Route Test', password: 'password123!' },
    });
    const token = mailer.verificationTokens.get(email);
    expect(token).toBeTruthy();

    const res = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token } });
    expect(res.statusCode).toBe(204);
  });

  it('returns 401 for invalid login credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.test', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('always returns 202 for password reset requests, registered or not', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-password-reset',
      payload: { email: 'nobody@example.test' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('resets a password via the captured token and allows login with the new one', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, name: 'Route Test', password: 'old-password' },
    });

    await app.inject({ method: 'POST', url: '/auth/request-password-reset', payload: { email } });
    const token = mailer.resetTokens.get(email);
    expect(token).toBeTruthy();

    const resetRes = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token, newPassword: 'new-password' },
    });
    expect(resetRes.statusCode).toBe(204);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'new-password' },
    });
    expect(loginRes.statusCode).toBe(200);
  });
});

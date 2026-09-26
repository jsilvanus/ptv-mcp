import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { refreshTokens, users } from '../db/schema/index.js';
import {
  AccountLockedError,
  AuthService,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidOrExpiredTokenError,
} from './authService.js';
import type { Mailer } from './mailer.js';

class FakeMailer implements Mailer {
  verificationTokens = new Map<string, string>();
  resetTokens = new Map<string, string>();

  async sendVerificationEmail(to: string, rawToken: string): Promise<void> {
    this.verificationTokens.set(to, rawToken);
  }

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    this.resetTokens.set(to, rawToken);
  }
}

describe('AuthService', () => {
  const config = loadConfig();
  let db: Database;
  let mailer: FakeMailer;
  let service: AuthService;
  let clock: Date;
  const testEmails: string[] = [];

  beforeEach(() => {
    db = createDatabase(config.databaseUrl);
    mailer = new FakeMailer();
    clock = new Date('2026-09-16T10:00:00Z');
    service = new AuthService({ db, jwtSecret: config.jwtSecret, mailer, now: () => clock });
  });

  afterEach(async () => {
    for (const email of testEmails) {
      await db.delete(users).where(eq(users.email, email));
    }
    testEmails.length = 0;
  });

  function uniqueEmail(): string {
    const email = `authservice-${crypto.randomUUID()}@example.test`;
    testEmails.push(email);
    return email;
  }

  it('registers a user and sends a verification email', async () => {
    const email = uniqueEmail();
    const { userId } = await service.register(email, 'Test User', 'correct horse battery staple');
    expect(userId).toBeTruthy();
    expect(mailer.verificationTokens.has(email)).toBe(true);

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(user?.emailVerifiedAt).toBeNull();
  });

  it('rejects registering the same email twice', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'password123!');
    await expect(service.register(email, 'Test User', 'password123!')).rejects.toThrow(
      EmailAlreadyRegisteredError,
    );
  });

  it('verifies an email with the token the mailer received', async () => {
    const email = uniqueEmail();
    const { userId } = await service.register(email, 'Test User', 'password123!');
    const token = mailer.verificationTokens.get(email);
    if (!token) throw new Error('no token captured');

    await service.verifyEmail(token);
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it('rejects an already-consumed verification token', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'password123!');
    const token = mailer.verificationTokens.get(email);
    if (!token) throw new Error('no token captured');

    await service.verifyEmail(token);
    await expect(service.verifyEmail(token)).rejects.toThrow(InvalidOrExpiredTokenError);
  });

  it('logs in with correct credentials and issues a session', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    const session = await service.login(email, 'correct-password');
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.expiresIn).toBeGreaterThan(0);
  });

  it('rejects an incorrect password without revealing which part was wrong', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    await expect(service.login(email, 'wrong-password')).rejects.toThrow(InvalidCredentialsError);
  });

  it('rejects login for a non-existent email with the same error as a wrong password', async () => {
    await expect(service.login('nobody@example.test', 'whatever')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('locks the account after repeated failed logins', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');

    for (let i = 0; i < 5; i++) {
      await expect(service.login(email, 'wrong-password')).rejects.toThrow(InvalidCredentialsError);
    }

    await expect(service.login(email, 'correct-password')).rejects.toThrow(AccountLockedError);
  });

  it('allows login again once the lockout window has passed', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    for (let i = 0; i < 5; i++) {
      await expect(service.login(email, 'wrong-password')).rejects.toThrow(InvalidCredentialsError);
    }
    await expect(service.login(email, 'correct-password')).rejects.toThrow(AccountLockedError);

    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    const session = await service.login(email, 'correct-password');
    expect(session.accessToken).toBeTruthy();
  });

  it('verifies credentials and returns the user id without issuing a session', async () => {
    const email = uniqueEmail();
    const { userId } = await service.register(email, 'Test User', 'correct-password');

    await expect(service.verifyCredentials(email, 'correct-password')).resolves.toBe(userId);
    const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('rejects bad credentials in verifyCredentials with the same error as login', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    await expect(service.verifyCredentials(email, 'wrong-password')).rejects.toThrow(
      InvalidCredentialsError,
    );
    await expect(service.verifyCredentials('nobody@example.test', 'whatever')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('counts verifyCredentials failures toward the same lockout as login', async () => {
    const email = uniqueEmail();
    const { userId } = await service.register(email, 'Test User', 'correct-password');

    for (let i = 0; i < 4; i++) {
      await expect(service.verifyCredentials(email, 'wrong-password')).rejects.toThrow(
        InvalidCredentialsError,
      );
    }
    let user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(user?.failedLoginAttempts).toBe(4);

    await expect(service.login(email, 'wrong-password')).rejects.toThrow(InvalidCredentialsError);
    await expect(service.verifyCredentials(email, 'correct-password')).rejects.toThrow(
      AccountLockedError,
    );
    await expect(service.login(email, 'correct-password')).rejects.toThrow(AccountLockedError);

    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    await expect(service.verifyCredentials(email, 'correct-password')).resolves.toBe(userId);
    user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(user?.failedLoginAttempts).toBe(0);
    expect(user?.lockedUntil).toBeNull();
  });

  it('rotates the refresh token and revokes the old one on refresh', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    const first = await service.login(email, 'correct-password');

    const second = await service.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Reusing the now-rotated-away token must fail.
    await expect(service.refresh(first.refreshToken)).rejects.toThrow(InvalidOrExpiredTokenError);
  });

  it('denylists the whole chain when a revoked refresh token is replayed', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    const first = await service.login(email, 'correct-password');
    const second = await service.refresh(first.refreshToken);

    // Replay of the already-rotated first token: denylist the chain, so
    // even the freshly-issued `second.refreshToken` stops working too.
    await expect(service.refresh(first.refreshToken)).rejects.toThrow(InvalidOrExpiredTokenError);
    await expect(service.refresh(second.refreshToken)).rejects.toThrow(InvalidOrExpiredTokenError);
  });

  it('revokes the refresh token on logout so it can no longer be used', async () => {
    const email = uniqueEmail();
    const { userId } = await service.register(email, 'Test User', 'correct-password');
    const session = await service.login(email, 'correct-password');

    await service.logout(userId, session.refreshToken);
    await expect(service.refresh(session.refreshToken)).rejects.toThrow(InvalidOrExpiredTokenError);
  });

  it("does not revoke another user's refresh token even if the caller supplies its raw value", async () => {
    const victimEmail = uniqueEmail();
    await service.register(victimEmail, 'Victim', 'correct-password');
    const victimSession = await service.login(victimEmail, 'correct-password');

    const attackerEmail = uniqueEmail();
    const { userId: attackerId } = await service.register(
      attackerEmail,
      'Attacker',
      'correct-password',
    );

    await service.logout(attackerId, victimSession.refreshToken);
    // Still valid: logout only revokes tokens owned by the calling user.
    await expect(service.refresh(victimSession.refreshToken)).resolves.toBeDefined();
  });

  it('resets the password with a valid token and revokes all sessions', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'old-password');
    const session = await service.login(email, 'old-password');

    await service.requestPasswordReset(email);
    const resetToken = mailer.resetTokens.get(email);
    if (!resetToken) throw new Error('no reset token captured');

    await service.resetPassword(resetToken, 'new-password');

    await expect(service.login(email, 'old-password')).rejects.toThrow(InvalidCredentialsError);
    const relogin = await service.login(email, 'new-password');
    expect(relogin.accessToken).toBeTruthy();

    // The pre-reset session's refresh token must be dead.
    await expect(service.refresh(session.refreshToken)).rejects.toThrow(InvalidOrExpiredTokenError);
  });

  it('does not reveal whether an email is registered when requesting a password reset', async () => {
    await expect(service.requestPasswordReset('nobody@example.test')).resolves.toBeUndefined();
  });

  it('rejects an expired refresh token', async () => {
    const email = uniqueEmail();
    await service.register(email, 'Test User', 'correct-password');
    const session = await service.login(email, 'correct-password');

    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    await expect(service.refresh(session.refreshToken)).rejects.toThrow(InvalidOrExpiredTokenError);
  });
});

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  emailVerificationTokens,
  passwordResetTokens,
  refreshTokens,
  users,
} from '../db/schema/index.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from './jwt.js';
import type { Mailer } from './mailer.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateOpaqueToken, hashToken } from './tokens.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class AccountLockedError extends Error {
  constructor(public readonly lockedUntil: Date) {
    super(`Account is locked until ${lockedUntil.toISOString()}`);
    this.name = 'AccountLockedError';
  }
}

export class InvalidOrExpiredTokenError extends Error {
  constructor(kind: string) {
    super(`Invalid or expired ${kind} token`);
    this.name = 'InvalidOrExpiredTokenError';
  }
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthServiceDeps {
  db: Database;
  jwtSecret: string;
  mailer: Mailer;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: () => Date;
}

/**
 * Auth business logic (Phase 3 Stream A). Deliberately framework-agnostic —
 * `src/routes/auth.ts` is the thin Fastify wiring on top of this, and this
 * class is what's unit-tested against a real Postgres instance.
 *
 * `users`/`refresh_tokens`/`email_verification_tokens`/`password_reset_tokens`
 * are not RLS-scoped (see their schema files), so this talks to `db`
 * directly rather than through `withContext`.
 */
export class AuthService {
  private readonly db: Database;
  private readonly jwtSecret: string;
  private readonly mailer: Mailer;
  private readonly now: () => Date;
  private dummyPasswordHash: Promise<string> | undefined;

  constructor(deps: AuthServiceDeps) {
    this.db = deps.db;
    this.jwtSecret = deps.jwtSecret;
    this.mailer = deps.mailer;
    this.now = deps.now ?? (() => new Date());
  }

  /** Computed once and cached — a fixed hash whose only purpose is to make `login()`'s unknown-email path spend the same Argon2id cost as its wrong-password path. */
  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword('not-a-real-account-timing-normalization');
    return this.dummyPasswordHash;
  }

  async register(email: string, name: string, password: string): Promise<{ userId: string }> {
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      throw new EmailAlreadyRegisteredError();
    }

    const passwordHash = await hashPassword(password);
    let user: typeof users.$inferSelect | undefined;
    try {
      [user] = await this.db.insert(users).values({ email, name, passwordHash }).returning();
    } catch (err) {
      // Two concurrent registrations for the same email can both pass the
      // existence check above (TOCTOU); the unique constraint on
      // users.email is the real guard — map its violation to the same
      // typed error the pre-check throws, rather than a raw 500.
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        throw new EmailAlreadyRegisteredError();
      }
      throw err;
    }
    if (!user) {
      throw new Error('User insert did not return a row');
    }

    await this.issueEmailVerificationToken(user.id, user.email);
    return { userId: user.id };
  }

  private async issueEmailVerificationToken(userId: string, email: string): Promise<void> {
    const rawToken = generateOpaqueToken();
    await this.db.insert(emailVerificationTokens).values({
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(this.now().getTime() + EMAIL_VERIFICATION_TTL_MS),
    });
    await this.mailer.sendVerificationEmail(email, rawToken);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const record = await this.db.query.emailVerificationTokens.findFirst({
      where: eq(emailVerificationTokens.tokenHash, tokenHash),
    });
    if (!record || record.consumedAt !== null || record.expiresAt < this.now()) {
      throw new InvalidOrExpiredTokenError('email verification');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(emailVerificationTokens)
        .set({ consumedAt: this.now() })
        .where(eq(emailVerificationTokens.id, record.id));
      await tx
        .update(users)
        .set({ emailVerifiedAt: this.now() })
        .where(eq(users.id, record.userId));
    });
  }

  async login(email: string, password: string): Promise<Session> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      // Same error as a wrong password — don't reveal whether the email is
      // registered. Also run a real (deliberately slow) Argon2id verify
      // against a fixed dummy hash so this path takes about as long as the
      // wrong-password path below; otherwise the two cases are
      // distinguishable by response time alone.
      await verifyPassword(await this.getDummyPasswordHash(), password);
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil && user.lockedUntil > this.now()) {
      throw new AccountLockedError(user.lockedUntil);
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginAttempts);
      throw new InvalidCredentialsError();
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.db
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    return this.issueSession(user.id);
  }

  private async recordFailedLogin(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    const lockedUntil =
      attempts >= LOCKOUT_THRESHOLD ? new Date(this.now().getTime() + LOCKOUT_DURATION_MS) : null;
    await this.db
      .update(users)
      .set({
        failedLoginAttempts: lockedUntil ? 0 : attempts,
        lockedUntil,
      })
      .where(eq(users.id, userId));
  }

  private async issueSession(userId: string, replacesTokenId?: string): Promise<Session> {
    const rawRefreshToken = generateOpaqueToken();
    const [refreshRow] = await this.db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: hashToken(rawRefreshToken),
        expiresAt: new Date(this.now().getTime() + REFRESH_TOKEN_TTL_MS),
      })
      .returning();
    if (!refreshRow) {
      throw new Error('Refresh token insert did not return a row');
    }

    if (replacesTokenId) {
      await this.db
        .update(refreshTokens)
        .set({ revokedAt: this.now(), replacedByTokenId: refreshRow.id })
        .where(eq(refreshTokens.id, replacesTokenId));
    }

    const accessToken = await signAccessToken({ sub: userId }, this.jwtSecret);
    return { accessToken, refreshToken: rawRefreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  async refresh(rawRefreshToken: string): Promise<Session> {
    const tokenHash = hashToken(rawRefreshToken);
    const record = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
    });

    if (!record) {
      throw new InvalidOrExpiredTokenError('refresh');
    }

    if (record.revokedAt !== null) {
      // Reuse of an already-rotated-away token: treat as a possible theft
      // and deny the whole chain, not just this one token (denylist, per
      // docs/plan.md's "refresh-token rotation + denylist" requirement).
      await this.revokeAllRefreshTokens(record.userId);
      throw new InvalidOrExpiredTokenError('refresh');
    }

    if (record.expiresAt < this.now()) {
      throw new InvalidOrExpiredTokenError('refresh');
    }

    return this.issueSession(record.userId, record.id);
  }

  /**
   * `userId` comes from the caller's own verified access token, never from
   * the request body — logout only revokes a refresh token that actually
   * belongs to the authenticated caller, so one user can't revoke another
   * user's session by supplying their refresh-token string.
   */
  async logout(userId: string, rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  private async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  /** Always succeeds from the caller's point of view — never reveals whether `email` is registered. */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      return;
    }

    const rawToken = generateOpaqueToken();
    await this.db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(this.now().getTime() + PASSWORD_RESET_TTL_MS),
    });
    await this.mailer.sendPasswordResetEmail(user.email, rawToken);
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const record = await this.db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.tokenHash, tokenHash),
    });
    if (!record || record.consumedAt !== null || record.expiresAt < this.now()) {
      throw new InvalidOrExpiredTokenError('password reset');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(passwordResetTokens)
        .set({ consumedAt: this.now() })
        .where(eq(passwordResetTokens.id, record.id));
      await tx
        .update(users)
        .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, record.userId));
    });
    // A password reset is a strong signal of account recovery from
    // compromise — invalidate every outstanding session, not just let the
    // old password's sessions linger.
    await this.revokeAllRefreshTokens(record.userId);
  }
}

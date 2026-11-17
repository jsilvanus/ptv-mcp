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
import { isPasswordSignInAllowed, normalizeEmail, type AuthMode } from './signInMode.js';
import { generateOpaqueToken, hashToken } from './tokens.js';
import { openIdToken } from '../oidc/idTokenSeal.js';

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

/** `AUTH_MODE=oidc`: accounts are created by single sign-on only. */
export class PasswordRegistrationDisabledError extends Error {
  constructor() {
    super('Self-registration is disabled. Sign in with single sign-on instead.');
    this.name = 'PasswordRegistrationDisabledError';
  }
}

export class AccountLockedError extends Error {
  constructor(public readonly lockedUntil: Date) {
    super(`Account is locked until ${lockedUntil.toISOString()}`);
    this.name = 'AccountLockedError';
  }
}

/** Raised only after the right password (or for a verified-IdP sign-in), so it does not reveal which emails exist. */
export class EmailNotVerifiedError extends Error {
  constructor() {
    super(
      'Email address is not verified yet. Use the verification link sent to you, or ask the administrator.',
    );
    this.name = 'EmailNotVerifiedError';
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
  /** `REQUIRE_VERIFIED_EMAIL`: refuse sign-in for accounts whose email is not verified. Default false. */
  requireVerifiedEmail?: boolean;
  /** `AUTH_MODE`. In `oidc`, passwords are checked only for `breakGlassEmails`. Default `local`. */
  authMode?: AuthMode;
  breakGlassEmails?: readonly string[];
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: () => Date;
  /** MASTER_ENCRYPTION_KEY: opens the sealed ID token kept for sign-out. Without it, sign-out is local only. */
  masterEncryptionKey?: string;
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
  private readonly requireVerifiedEmail: boolean;
  private readonly authMode: AuthMode;
  private readonly breakGlassEmails: ReadonlySet<string>;
  private dummyPasswordHash: Promise<string> | undefined;
  private readonly masterEncryptionKey: string | undefined;

  constructor(deps: AuthServiceDeps) {
    this.masterEncryptionKey = deps.masterEncryptionKey;
    this.db = deps.db;
    this.jwtSecret = deps.jwtSecret;
    this.mailer = deps.mailer;
    this.now = deps.now ?? (() => new Date());
    this.requireVerifiedEmail = deps.requireVerifiedEmail ?? false;
    this.authMode = deps.authMode ?? 'local';
    this.breakGlassEmails = new Set((deps.breakGlassEmails ?? []).map(normalizeEmail));
  }

  /** Whether `email` may sign in with a password under the configured `AUTH_MODE`. */
  allowsPasswordSignIn(email: string): boolean {
    return isPasswordSignInAllowed(this.authMode, this.breakGlassEmails, email);
  }

  /** Computed once and cached — a fixed hash whose only purpose is to make `verifyCredentials()`'s unknown-email path spend the same Argon2id cost as its wrong-password path. */
  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword('not-a-real-account-timing-normalization');
    return this.dummyPasswordHash;
  }

  async register(email: string, name: string, password: string): Promise<{ userId: string }> {
    if (this.authMode === 'oidc') {
      throw new PasswordRegistrationDisabledError();
    }
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
    const userId = await this.verifyCredentials(email, password);
    return this.issueSession(userId);
  }

  /**
   * Checks `email`/`password` (with the same lockout and failed-attempt
   * handling as `login()`) and returns the user id, without issuing a
   * web-UI session. For callers that only need to know who the user is,
   * e.g. the MCP OAuth consent form and `npm run mcp:token` — those mint
   * their own MCP OAuth tokens, so a refresh-token row here would just be
   * an unused 30-day session nobody can revoke.
   */
  async verifyCredentials(email: string, password: string): Promise<string> {
    if (!this.allowsPasswordSignIn(email)) {
      // SSO-only mode: same answer and cost as a wrong password, so the
      // refusal does not reveal whether the account exists.
      await verifyPassword(await this.getDummyPasswordHash(), password);
      throw new InvalidCredentialsError();
    }

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

    this.assertNotLocked(user);

    if (user.passwordHash === null) {
      // An account created by OIDC sign-in has no password (until a reset
      // sets one). Same answer and cost as an unknown email.
      await verifyPassword(await this.getDummyPasswordHash(), password);
      throw new InvalidCredentialsError();
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

    this.assertEmailVerified(user);
    return user.id;
  }

  /** The account state checks every sign-in path applies (today: the login lockout). */
  private assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (user.lockedUntil && user.lockedUntil > this.now()) {
      throw new AccountLockedError(user.lockedUntil);
    }
  }

  /** With `REQUIRE_VERIFIED_EMAIL`, an account whose email was never verified cannot sign in. */
  private assertEmailVerified(user: { emailVerifiedAt: Date | null }): void {
    if (this.requireVerifiedEmail && user.emailVerifiedAt === null) {
      throw new EmailNotVerifiedError();
    }
  }

  /**
   * For sign-in paths that identified the user some other way (OIDC,
   * `src/oidc/`): refuses the account exactly as `verifyCredentials()` would
   * before checking a password. Throws `InvalidCredentialsError` for an
   * unknown user id.
   */
  async assertCanSignIn(userId: string): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new InvalidCredentialsError();
    this.assertNotLocked(user);
    this.assertEmailVerified(user);
  }

  /**
   * The web-UI session `login()` returns, for a user already identified and
   * checked with `assertCanSignIn()` (OIDC web sign-in).
   */
  async createSession(
    userId: string,
    options: { oidcIdTokenSealed?: string | null } = {},
  ): Promise<Session> {
    await this.assertCanSignIn(userId);
    return this.issueSession(userId, undefined, options.oidcIdTokenSealed ?? null);
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

  private async issueSession(
    userId: string,
    replacesTokenId?: string,
    oidcIdTokenSealed: string | null = null,
  ): Promise<Session> {
    const rawRefreshToken = generateOpaqueToken();
    const [refreshRow] = await this.db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: hashToken(rawRefreshToken),
        expiresAt: new Date(this.now().getTime() + REFRESH_TOKEN_TTL_MS),
        oidcIdTokenSealed,
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

    // The sign-out hint outlives rotation, so a refreshed session still signs out at the IdP.
    return this.issueSession(record.userId, record.id, record.oidcIdTokenSealed);
  }

  /**
   * `userId` comes from the caller's own verified access token, never from
   * the request body — logout only revokes a refresh token that actually
   * belongs to the authenticated caller, so one user can't revoke another
   * user's session by supplying their refresh-token string.
   */
  async logout(
    userId: string,
    rawRefreshToken: string,
  ): Promise<{ oidcIdTokenHint: string | null }> {
    const tokenHash = hashToken(rawRefreshToken);
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ sealed: refreshTokens.oidcIdTokenSealed });
    // Only a session that was revoked just now yields its IdP hint: a stale or foreign token yields none.
    const sealed = rows[0]?.sealed ?? null;
    if (!sealed || !this.masterEncryptionKey) return { oidcIdTokenHint: null };
    try {
      return { oidcIdTokenHint: openIdToken(this.masterEncryptionKey, sealed) };
    } catch {
      // The session is already revoked; an unreadable hint only means sign-out stays local.
      return { oidcIdTokenHint: null };
    }
  }

  private async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  /** Always succeeds from the caller's point of view — never reveals whether `email` is registered. */
  async requestPasswordReset(email: string): Promise<void> {
    if (!this.allowsPasswordSignIn(email)) {
      return;
    }
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

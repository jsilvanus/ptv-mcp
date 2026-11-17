import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  oidcIdentities,
  oidcLoginStates,
  oidcWebHandoffs,
  refreshTokens,
  users,
} from '../db/schema/index.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import type { OidcIdentityClaims } from './oidcClient.js';

/** Lifetime of a started sign-in (state row and cookie). */
export const OIDC_STATE_TTL_SECONDS = 600;
/** Lifetime of the code that hands a finished web sign-in to the SPA. */
const WEB_HANDOFF_TTL_MS = 60 * 1000;

export type OidcPurpose = 'web' | 'oauth';

export interface OidcLoginState {
  codeVerifier: string;
  nonce: string;
  purpose: OidcPurpose;
  oauthRequest: string | null;
}

/** A sign-in the app refuses; `message` is safe to show the user. */
export class OidcSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcSignInError';
  }
}

export const NO_ACCOUNT_MESSAGE = 'No account for this sign-in; ask the administrator.';

export interface OidcServiceOptions {
  createUsers: boolean;
  trustEmail: boolean;
  now?: () => Date;
}

/**
 * Server-side state of OIDC sign-ins and the mapping from an IdP identity to
 * a local user. `users` and these tables are not RLS-scoped, so this talks
 * to `db` directly (like AuthService).
 */
export class OidcService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly options: OidcServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Stores a started sign-in keyed by SHA-256(state), and removes expired ones. */
  async saveLoginState(state: string, value: OidcLoginState): Promise<void> {
    const now = this.now();
    await this.db.delete(oidcLoginStates).where(lt(oidcLoginStates.expiresAt, now));
    await this.db.delete(oidcWebHandoffs).where(lt(oidcWebHandoffs.expiresAt, now));
    await this.db.insert(oidcLoginStates).values({
      stateHash: hashToken(state),
      codeVerifier: value.codeVerifier,
      nonce: value.nonce,
      purpose: value.purpose,
      oauthRequest: value.oauthRequest,
      expiresAt: new Date(now.getTime() + OIDC_STATE_TTL_SECONDS * 1000),
    });
  }

  /** Takes a started sign-in out of the store (single use); null when unknown or expired. */
  async consumeLoginState(state: string): Promise<OidcLoginState | null> {
    const [row] = await this.db
      .delete(oidcLoginStates)
      .where(eq(oidcLoginStates.stateHash, hashToken(state)))
      .returning();
    if (!row || row.expiresAt < this.now()) return null;
    return {
      codeVerifier: row.codeVerifier,
      nonce: row.nonce,
      purpose: row.purpose,
      oauthRequest: row.oauthRequest,
    };
  }

  /**
   * The local user for an IdP identity: a linked identity first, then an
   * existing account with the same (trusted) email, then, with
   * `OIDC_CREATE_USERS`, a new account. Throws `OidcSignInError` otherwise.
   * Account state (lockout) is checked by the caller via AuthService.
   */
  async resolveUser(claims: OidcIdentityClaims): Promise<string> {
    const linked = await this.db.query.oidcIdentities.findFirst({
      where: and(
        eq(oidcIdentities.issuer, claims.issuer),
        eq(oidcIdentities.subject, claims.subject),
      ),
    });
    if (linked) {
      await this.touch(claims);
      return linked.userId;
    }

    const trustedEmail =
      claims.email && (claims.emailVerified || this.options.trustEmail) ? claims.email : undefined;

    if (trustedEmail) {
      const existing = await this.findUserByEmail(trustedEmail);
      if (existing) {
        if (existing.emailVerifiedAt === null) {
          await this.claimUnverifiedAccount(claims, existing.id);
        } else {
          await this.link(claims, existing.id);
        }
        return existing.id;
      }
    }

    if (!this.options.createUsers) throw new OidcSignInError(NO_ACCOUNT_MESSAGE);
    if (!trustedEmail) {
      // users.email is required and is how memberships find people, so an
      // account is only created from an email the IdP vouches for.
      throw new OidcSignInError(
        'Your sign-in did not include a verified email address, so no account could be created; ask the administrator.',
      );
    }

    const name = claims.name ?? claims.preferredUsername ?? trustedEmail;
    let userId: string;
    try {
      const [created] = await this.db
        .insert(users)
        .values({
          email: trustedEmail,
          name,
          passwordHash: null,
          emailVerifiedAt: claims.emailVerified ? this.now() : null,
        })
        .returning({ id: users.id });
      if (!created) throw new Error('User insert did not return a row');
      userId = created.id;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        throw new OidcSignInError(NO_ACCOUNT_MESSAGE);
      }
      throw err;
    }
    await this.link(claims, userId);
    return userId;
  }

  /**
   * Exact match first, then a single case-insensitive match (users.email is
   * unique case-sensitively). Returns the account's id and whether its email
   * was ever verified.
   */
  private async findUserByEmail(
    email: string,
  ): Promise<{ id: string; emailVerifiedAt: Date | null } | null> {
    const exact = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (exact) return { id: exact.id, emailVerifiedAt: exact.emailVerifiedAt };
    const rows = await this.db
      .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(2);
    const [row] = rows;
    return rows.length === 1 && row ? row : null;
  }

  /**
   * Links an IdP identity to a local account whose email was never verified.
   * Such an account may have been registered by someone else with an address
   * that person does not control, so when the IdP-verified owner arrives its
   * password and sessions are dropped; the owner can set a password again
   * through password reset. An account that already proved its email is never
   * touched here (see `resolveUser`).
   */
  private async claimUnverifiedAccount(claims: OidcIdentityClaims, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: null,
          ...(claims.emailVerified ? { emailVerifiedAt: this.now() } : {}),
        })
        .where(eq(users.id, userId));
      await tx
        .update(refreshTokens)
        .set({ revokedAt: this.now() })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    });
    await this.link(claims, userId);
  }

  private async link(claims: OidcIdentityClaims, userId: string): Promise<void> {
    await this.db
      .insert(oidcIdentities)
      .values({
        issuer: claims.issuer,
        subject: claims.subject,
        userId,
        lastLoginAt: this.now(),
      })
      .onConflictDoNothing();
  }

  private async touch(claims: OidcIdentityClaims): Promise<void> {
    await this.db
      .update(oidcIdentities)
      .set({ lastLoginAt: this.now() })
      .where(
        and(eq(oidcIdentities.issuer, claims.issuer), eq(oidcIdentities.subject, claims.subject)),
      );
  }

  /** A one-time code the SPA exchanges for its session (`POST /oidc/session`). */
  /** `idTokenHint` is the IdP's ID token, carried to the session for sign-out. */
  async createWebHandoff(userId: string, idTokenHint?: string): Promise<string> {
    const code = generateOpaqueToken();
    await this.db.insert(oidcWebHandoffs).values({
      codeHash: hashToken(code),
      userId,
      expiresAt: new Date(this.now().getTime() + WEB_HANDOFF_TTL_MS),
      idTokenHint: idTokenHint ?? null,
    });
    return code;
  }

  /** Single use; null when unknown or expired. */
  async consumeWebHandoff(
    code: string,
  ): Promise<{ userId: string; idTokenHint: string | null } | null> {
    const [row] = await this.db
      .delete(oidcWebHandoffs)
      .where(eq(oidcWebHandoffs.codeHash, hashToken(code)))
      .returning();
    if (!row || row.expiresAt < this.now()) return null;
    return { userId: row.userId, idTokenHint: row.idTokenHint };
  }
}

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import {
  memberships,
  oidcIdentities,
  oidcLoginStates,
  oidcWebHandoffs,
  refreshTokens,
  tenants,
  users,
} from '../db/schema/index.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import type { OidcGroupSyncConfig } from '../config.js';
import type { AuditService } from '../audit/auditService.js';
import type { MembershipRole } from '../auth/rbac.js';
import type { OidcIdentityClaims } from './oidcClient.js';
import { sealIdToken } from './idTokenSeal.js';
import { parseGroupGrants } from './groupGrants.js';

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
  /** MASTER_ENCRYPTION_KEY: seals the ID token kept for sign-out. */
  masterEncryptionKey: string;
  /** `OIDC_GROUP_SYNC`: when set, `syncGroupMemberships` grants tenant roles from groups. */
  groupSync?: OidcGroupSyncConfig;
  /** Records each membership a group sync changes. */
  auditService?: AuditService;
  now?: () => Date;
}

/** One membership a group sync changed, for the audit log. */
interface GroupMembershipChange {
  tenantId: string;
  action: 'AddGroupMembership' | 'UpdateGroupMembership' | 'RemoveGroupMembership';
  role: MembershipRole;
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

  /**
   * Makes the IdP-sourced memberships of `userId` match the groups the IdP
   * sent at this sign-in. Runs only when group sync is on (otherwise a no-op).
   *
   * - A tenant granted by a group gets that role, unless the user already has
   *   a membership there that a tenant admin set by hand: manual rows are left
   *   alone, in both directions.
   * - An `oidc` row whose group is gone is removed.
   * - Tenants are matched by slug; unknown slugs are skipped.
   * - Access granted here lasts until the next SSO sign-in (no back-channel
   *   logout is wired up), so a removed group takes effect at that point.
   *
   * An absent groups claim counts as no groups. Returns the group names that
   * named no grant, for the caller to log.
   */
  async syncGroupMemberships(
    userId: string,
    groups: readonly string[] | undefined,
  ): Promise<{ ignored: string[] }> {
    const sync = this.options.groupSync;
    if (!sync) return { ignored: [] };

    const { grants, ignored } = parseGroupGrants(groups ?? [], sync.prefix);
    const slugs = [...grants.keys()];
    const tenantRows =
      slugs.length > 0
        ? await this.db
            .select({ id: tenants.id, slug: tenants.slug })
            .from(tenants)
            .where(inArray(tenants.slug, slugs))
        : [];
    const tenantIdBySlug = new Map(tenantRows.map((row) => [row.slug, row.id]));
    const granted = new Map<string, MembershipRole>();
    for (const [slug, role] of grants) {
      const tenantId = tenantIdBySlug.get(slug);
      if (tenantId) granted.set(tenantId, role);
    }

    const changes: GroupMembershipChange[] = [];
    // RLS lets this user see and write their own membership rows.
    await withContext(this.db, { userId }, async (tx) => {
      const current = await tx
        .select({
          tenantId: memberships.tenantId,
          role: memberships.role,
          source: memberships.source,
        })
        .from(memberships)
        .where(eq(memberships.userId, userId));
      const currentByTenant = new Map(current.map((row) => [row.tenantId, row]));

      for (const row of current) {
        if (row.source === 'oidc' && !granted.has(row.tenantId)) {
          await tx
            .delete(memberships)
            .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, row.tenantId)));
          changes.push({
            tenantId: row.tenantId,
            action: 'RemoveGroupMembership',
            role: row.role,
          });
        }
      }

      for (const [tenantId, role] of granted) {
        const existing = currentByTenant.get(tenantId);
        if (existing?.source === 'manual') continue;
        if (existing?.role === role) continue;
        if (existing) {
          await tx
            .update(memberships)
            .set({ role, updatedAt: this.now() })
            .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)));
          changes.push({ tenantId, action: 'UpdateGroupMembership', role });
        } else {
          await tx.insert(memberships).values({ userId, tenantId, role, source: 'oidc' });
          changes.push({ tenantId, action: 'AddGroupMembership', role });
        }
      }
    });

    for (const change of changes) {
      await this.options.auditService?.record({
        tenantId: change.tenantId,
        userId,
        action: change.action,
        resourceType: 'Membership',
        resourceId: userId,
        afterState: change.action === 'RemoveGroupMembership' ? undefined : { role: change.role },
        result: 'Success',
      });
    }
    return { ignored };
  }

  /** A one-time code the SPA exchanges for its session (`POST /oidc/session`). */
  /** `idToken` is the IdP's ID token; it is sealed here and carried to the session for sign-out. */
  async createWebHandoff(userId: string, idToken?: string): Promise<string> {
    const code = generateOpaqueToken();
    await this.db.insert(oidcWebHandoffs).values({
      codeHash: hashToken(code),
      userId,
      expiresAt: new Date(this.now().getTime() + WEB_HANDOFF_TTL_MS),
      idTokenSealed: idToken ? sealIdToken(this.options.masterEncryptionKey, idToken) : null,
    });
    return code;
  }

  /** Single use; null when unknown or expired. `idTokenSealed` stays sealed. */
  async consumeWebHandoff(
    code: string,
  ): Promise<{ userId: string; idTokenSealed: string | null } | null> {
    const [row] = await this.db
      .delete(oidcWebHandoffs)
      .where(eq(oidcWebHandoffs.codeHash, hashToken(code)))
      .returning();
    if (!row || row.expiresAt < this.now()) return null;
    return { userId: row.userId, idTokenSealed: row.idTokenSealed };
  }
}

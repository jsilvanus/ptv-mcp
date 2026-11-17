import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext, type TransactionalDb } from '../db/context.js';
import { memberships, proposalReviewers, proposals, tenants, users } from '../db/schema/index.js';
import type { MembershipRole } from '../auth/rbac.js';
import type { AuditService } from '../audit/auditService.js';

export class SlugAlreadyTakenError extends Error {
  constructor(slug: string) {
    super(`Tenant slug already in use: ${slug}`);
    this.name = 'SlugAlreadyTakenError';
  }
}

export class UserNotFoundError extends Error {
  constructor(email: string) {
    super(`No user registered with email: ${email}`);
    this.name = 'UserNotFoundError';
  }
}

export class MembershipNotFoundError extends Error {
  constructor() {
    super('Membership not found');
    this.name = 'MembershipNotFoundError';
  }
}

/** `REQUIRE_VERIFIED_EMAIL`: the account must prove it owns its email before a tenant can add it. */
export class EmailNotVerifiedForMembershipError extends Error {
  constructor(email: string) {
    super(`${email} has not verified their email address yet, so the account cannot be added.`);
    this.name = 'EmailNotVerifiedForMembershipError';
  }
}

/**
 * Refused: removing or demoting the tenant's only Tenant Admin would leave an
 * organisation nobody can manage.
 */
export class LastTenantAdminError extends Error {
  constructor() {
    super('The tenant must keep at least one Tenant Admin (Pääkäyttäjä).');
    this.name = 'LastTenantAdminError';
  }
}

export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
}

export interface TenantSettings {
  /** Four-eyes: nobody approves (export/apply) a proposal they created. */
  requireFourEyes: boolean;
}

export class TenantNotFoundError extends Error {
  constructor() {
    super('Tenant not found');
    this.name = 'TenantNotFoundError';
  }
}

/** Whether `tenantId` enforces four-eyes; unknown tenants fail closed (true). */
export async function tenantRequiresFourEyes(db: Database, tenantId: string): Promise<boolean> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { requireFourEyes: true },
  });
  return tenant?.requireFourEyes ?? true;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
}

/**
 * Locks the tenant's Tenant Admin membership rows until `tx` ends and returns
 * their user ids. Two concurrent demotions or removals both take this lock:
 * the second waits, then re-reads the admins after the first has committed,
 * so it sees the new count and is refused rather than leaving no admin.
 */
async function lockTenantAdmins(tx: TransactionalDb, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'tenant_admin')))
    .orderBy(asc(memberships.userId))
    .for('update');
  return rows.map((row) => row.userId);
}

/** Throws when `userId` is the only Tenant Admin, so leaving them out would leave none. */
function assertNotLastAdmin(admins: string[], userId: string): void {
  if (admins.length === 1 && admins[0] === userId) throw new LastTenantAdminError();
}

/**
 * Tenant/membership CRUD (Phase 3 Stream B). `tenants` itself isn't
 * RLS-scoped (see drizzle/0001_row_level_security.sql — a tenant IS the
 * isolation boundary, not a row inside one), but every membership write
 * or read below still goes through `withContext` because `memberships`
 * is RLS-scoped.
 */
export class TenantService {
  constructor(
    private readonly db: Database,
    private readonly auditService: AuditService,
    private readonly options: { requireVerifiedEmail?: boolean } = {},
  ) {}

  /** Creates a tenant and makes `creatingUserId` its first Tenant Admin, atomically. */
  async createTenant(
    name: string,
    slug: string,
    creatingUserId: string,
  ): Promise<{ tenantId: string }> {
    const existing = await this.db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (existing) {
      throw new SlugAlreadyTakenError(slug);
    }

    return this.db.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenants).values({ name, slug }).returning();
      if (!tenant) {
        throw new Error('Tenant insert did not return a row');
      }
      // Same transaction as the tenant insert above — `withContext` would open a
      // separate one that can't yet see this uncommitted row (FK violation).
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`);
      await tx
        .insert(memberships)
        .values({ userId: creatingUserId, tenantId: tenant.id, role: 'tenant_admin' });
      return { tenantId: tenant.id };
    });
  }

  /** Every tenant `userId` belongs to, with their role in each — relies on the
   * Phase 1 reopen widening `memberships`' RLS policy for self-visibility. */
  async listTenantsForUser(userId: string): Promise<TenantMembership[]> {
    const rows = await withContext(this.db, { userId }, async (tx) =>
      tx
        .select({
          tenantId: tenants.id,
          tenantName: tenants.name,
          tenantSlug: tenants.slug,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
        .where(eq(memberships.userId, userId)),
    );
    return rows;
  }

  /** All members of one tenant — caller must already have verified a sufficient role (see rbac.ts). */
  async listMembers(tenantId: string): Promise<Member[]> {
    return withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.tenantId, tenantId)),
    );
  }

  /**
   * Adds (or re-roles) a member by email. Refused attempts are audited as
   * `NotApplied` and then thrown; the REST route turns both refusals into the
   * same neutral answer, so a Tenant Admin cannot learn which emails have accounts.
   */
  async addMember(
    tenantId: string,
    email: string,
    role: MembershipRole,
    actingUserId: string,
  ): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      await this.recordNotApplied(tenantId, actingUserId, null, role, 'UnknownEmail');
      throw new UserNotFoundError(email);
    }
    if (this.options.requireVerifiedEmail && user.emailVerifiedAt === null) {
      await this.recordNotApplied(tenantId, actingUserId, user.id, role, 'EmailNotVerified');
      throw new EmailNotVerifiedForMembershipError(email);
    }
    await withContext(this.db, { tenantId }, async (tx) => {
      await tx
        .insert(memberships)
        .values({ tenantId, userId: user.id, role, source: 'manual' })
        .onConflictDoUpdate({
          target: [memberships.userId, memberships.tenantId],
          set: { role, source: 'manual' },
        });
    });
    await this.auditService.record({
      tenantId,
      userId: actingUserId,
      action: 'AddMember',
      resourceType: 'Membership',
      resourceId: user.id,
      afterState: { role },
      result: 'Success',
    });
  }

  /** Refuses (LastTenantAdminError) a change that would leave the tenant with no Tenant Admin. */
  async updateMemberRole(
    tenantId: string,
    userId: string,
    role: MembershipRole,
    actingUserId: string,
  ): Promise<void> {
    await withContext(this.db, { tenantId, userId }, async (tx) => {
      const admins = await lockTenantAdmins(tx, tenantId);
      if (role !== 'tenant_admin') assertNotLastAdmin(admins, userId);
      const result = await tx
        .update(memberships)
        .set({ role, source: 'manual' })
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .returning({ userId: memberships.userId });
      if (result.length === 0) {
        throw new MembershipNotFoundError();
      }
    });
    await this.auditService.record({
      tenantId,
      userId: actingUserId,
      action: 'UpdateMemberRole',
      resourceType: 'Membership',
      resourceId: userId,
      afterState: { role },
      result: 'Success',
    });
  }

  /**
   * Removes a member and, in the same transaction, drops their required-reviewer
   * rows on pending proposals, so approval does not wait for someone who has
   * left. Refuses (LastTenantAdminError) when they are the only Tenant Admin.
   */
  async removeMember(tenantId: string, userId: string, actingUserId: string): Promise<void> {
    const droppedReviewerRequests = await withContext(this.db, { tenantId, userId }, async (tx) => {
      const admins = await lockTenantAdmins(tx, tenantId);
      assertNotLastAdmin(admins, userId);
      await tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
      const dropped = await tx
        .delete(proposalReviewers)
        .where(
          and(
            eq(proposalReviewers.tenantId, tenantId),
            eq(proposalReviewers.userId, userId),
            inArray(
              proposalReviewers.proposalId,
              tx
                .select({ id: proposals.id })
                .from(proposals)
                .where(and(eq(proposals.tenantId, tenantId), eq(proposals.status, 'pending'))),
            ),
          ),
        )
        .returning({ id: proposalReviewers.id });
      return dropped.length;
    });
    await this.auditService.record({
      tenantId,
      userId: actingUserId,
      action: 'RemoveMember',
      resourceType: 'Membership',
      resourceId: userId,
      afterState: { droppedReviewerRequests },
      result: 'Success',
    });
  }

  /** Audits a refused add without the email itself (audit payloads are scrubbed; the reason is enough). */
  private async recordNotApplied(
    tenantId: string,
    actingUserId: string,
    resourceId: string | null,
    role: MembershipRole,
    reason: 'UnknownEmail' | 'EmailNotVerified',
  ): Promise<void> {
    await this.auditService.record({
      tenantId,
      userId: actingUserId,
      action: 'AddMember',
      resourceType: 'Membership',
      resourceId,
      afterState: { role, reason },
      result: 'NotApplied',
    });
  }

  async getSettings(tenantId: string): Promise<TenantSettings> {
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { requireFourEyes: true },
    });
    if (!tenant) {
      throw new TenantNotFoundError();
    }
    return { requireFourEyes: tenant.requireFourEyes };
  }

  async updateSettings(
    tenantId: string,
    settings: TenantSettings,
    actingUserId: string,
  ): Promise<TenantSettings> {
    const before = await this.getSettings(tenantId);
    await this.db
      .update(tenants)
      .set({ requireFourEyes: settings.requireFourEyes, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
    await this.auditService.record({
      tenantId,
      userId: actingUserId,
      action: 'UpdateTenantSettings',
      resourceType: 'Tenant',
      resourceId: tenantId,
      beforeState: before,
      afterState: settings,
      result: 'Success',
    });
    return settings;
  }
}

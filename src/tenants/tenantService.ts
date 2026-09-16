import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships, tenants, users } from '../db/schema/index.js';
import type { MembershipRole } from '../auth/rbac.js';

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

export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
}

/**
 * Tenant/membership CRUD (Phase 3 Stream B). `tenants` itself isn't
 * RLS-scoped (see drizzle/0001_row_level_security.sql — a tenant IS the
 * isolation boundary, not a row inside one), but every membership write
 * or read below still goes through `withContext` because `memberships`
 * is RLS-scoped.
 */
export class TenantService {
  constructor(private readonly db: Database) {}

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

  async addMember(tenantId: string, email: string, role: MembershipRole): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      throw new UserNotFoundError(email);
    }
    await withContext(this.db, { tenantId }, async (tx) => {
      await tx
        .insert(memberships)
        .values({ tenantId, userId: user.id, role })
        .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } });
    });
  }

  async updateMemberRole(tenantId: string, userId: string, role: MembershipRole): Promise<void> {
    const result = await withContext(this.db, { tenantId, userId }, async (tx) =>
      tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .returning(),
    );
    if (result.length === 0) {
      throw new MembershipNotFoundError();
    }
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    await withContext(this.db, { tenantId, userId }, async (tx) => {
      await tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    });
  }
}

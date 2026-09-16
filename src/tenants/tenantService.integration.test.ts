import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships, tenants, users } from '../db/schema/index.js';
import {
  MembershipNotFoundError,
  SlugAlreadyTakenError,
  TenantService,
  UserNotFoundError,
} from './tenantService.js';

describe('TenantService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const service = new TenantService(db);

  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    for (const tenantId of createdTenantIds) {
      await withContext(db, { tenantId }, async (tx) => {
        await tx.delete(memberships).where(eq(memberships.tenantId, tenantId));
      });
    }
    if (createdTenantIds.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    createdTenantIds.length = 0;
    createdUserIds.length = 0;
  });

  async function createUser(name: string): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await db.insert(users).values({ id, email, name, passwordHash: 'x' });
    createdUserIds.push(id);
    return { id, email };
  }

  it('creates a tenant and makes the creator its tenant_admin', async () => {
    const admin = await createUser('Admin');
    const slug = `tenant-${randomUUID()}`;
    const { tenantId } = await service.createTenant('Test Tenant', slug, admin.id);
    createdTenantIds.push(tenantId);

    const mine = await service.listTenantsForUser(admin.id);
    expect(mine).toEqual([
      { tenantId, tenantName: 'Test Tenant', tenantSlug: slug, role: 'tenant_admin' },
    ]);
  });

  it('rejects a duplicate slug', async () => {
    const admin = await createUser('Admin');
    const slug = `tenant-${randomUUID()}`;
    const { tenantId } = await service.createTenant('First', slug, admin.id);
    createdTenantIds.push(tenantId);

    await expect(service.createTenant('Second', slug, admin.id)).rejects.toThrow(
      SlugAlreadyTakenError,
    );
  });

  it('lists every tenant a user belongs to, across tenants', async () => {
    const user = await createUser('Multi Tenant User');
    const a = await service.createTenant('Tenant A', `a-${randomUUID()}`, user.id);
    const b = await service.createTenant('Tenant B', `b-${randomUUID()}`, user.id);
    createdTenantIds.push(a.tenantId, b.tenantId);

    const mine = await service.listTenantsForUser(user.id);
    expect(mine.map((m) => m.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('adds a member by email and lists members for the tenant', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    createdTenantIds.push(tenantId);

    await service.addMember(tenantId, member.email, 'editor');
    const members = await service.listMembers(tenantId);
    expect(members).toContainEqual({
      userId: member.id,
      email: member.email,
      name: 'Member',
      role: 'editor',
    });
  });

  it('rejects adding a member with an unregistered email', async () => {
    const admin = await createUser('Admin');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    createdTenantIds.push(tenantId);

    await expect(service.addMember(tenantId, 'nobody@example.test', 'reader')).rejects.toThrow(
      UserNotFoundError,
    );
  });

  it('updates a member role', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    createdTenantIds.push(tenantId);
    await service.addMember(tenantId, member.email, 'reader');

    await service.updateMemberRole(tenantId, member.id, 'publisher');
    const members = await service.listMembers(tenantId);
    expect(members.find((m) => m.userId === member.id)?.role).toBe('publisher');
  });

  it('rejects updating a role for a non-existent membership', async () => {
    const admin = await createUser('Admin');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    createdTenantIds.push(tenantId);

    await expect(service.updateMemberRole(tenantId, randomUUID(), 'publisher')).rejects.toThrow(
      MembershipNotFoundError,
    );
  });

  it('removes a member', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    createdTenantIds.push(tenantId);
    await service.addMember(tenantId, member.email, 'reader');

    await service.removeMember(tenantId, member.id);
    const members = await service.listMembers(tenantId);
    expect(members.find((m) => m.userId === member.id)).toBeUndefined();
  });
});

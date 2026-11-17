import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships, tenants, users } from '../db/schema/index.js';
import { AuditService } from '../audit/auditService.js';
import { ProposalService } from '../proposals/proposalService.js';
import {
  EmailNotVerifiedForMembershipError,
  LastTenantAdminError,
  MembershipNotFoundError,
  SlugAlreadyTakenError,
  TenantService,
  UserNotFoundError,
} from './tenantService.js';
import { createTenantWithAdmin } from './createTenant.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';

describe('TenantService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const service = new TenantService(db, new AuditService(db));

  const fixtures = new IntegrationFixtures(db, config);

  afterEach(() => fixtures.cleanup());

  async function createUser(name: string): Promise<{ id: string; email: string }> {
    const id = await fixtures.user(name);
    return { id, email: `${id}@example.test` };
  }

  it('creates a tenant and makes the creator its tenant_admin', async () => {
    const admin = await createUser('Admin');
    const slug = `tenant-${randomUUID()}`;
    const { tenantId } = await service.createTenant('Test Tenant', slug, admin.id);
    fixtures.trackTenant(tenantId);

    const mine = await service.listTenantsForUser(admin.id);
    expect(mine).toEqual([
      { tenantId, tenantName: 'Test Tenant', tenantSlug: slug, role: 'tenant_admin' },
    ]);
  });

  it('rejects a duplicate slug', async () => {
    const admin = await createUser('Admin');
    const slug = `tenant-${randomUUID()}`;
    const { tenantId } = await service.createTenant('First', slug, admin.id);
    fixtures.trackTenant(tenantId);

    await expect(service.createTenant('Second', slug, admin.id)).rejects.toThrow(
      SlugAlreadyTakenError,
    );
  });

  it('lists every tenant a user belongs to, across tenants', async () => {
    const user = await createUser('Multi Tenant User');
    const a = await service.createTenant('Tenant A', `a-${randomUUID()}`, user.id);
    const b = await service.createTenant('Tenant B', `b-${randomUUID()}`, user.id);
    fixtures.trackTenant(a.tenantId);
    fixtures.trackTenant(b.tenantId);

    const mine = await service.listTenantsForUser(user.id);
    expect(mine.map((m) => m.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('adds a member by email and lists members for the tenant', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);

    await service.addMember(tenantId, member.email, 'approver', admin.id);
    const members = await service.listMembers(tenantId);
    expect(members).toContainEqual({
      userId: member.id,
      email: member.email,
      name: 'Member',
      role: 'approver',
    });
  });

  it('rejects adding a member with an unregistered email', async () => {
    const admin = await createUser('Admin');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);

    await expect(
      service.addMember(tenantId, 'nobody@example.test', 'contributor', admin.id),
    ).rejects.toThrow(UserNotFoundError);
  });

  it('refuses to add a member with an unverified email when REQUIRE_VERIFIED_EMAIL is on', async () => {
    const strict = new TenantService(db, new AuditService(db), { requireVerifiedEmail: true });
    const admin = await createUser('Admin');
    const member = await createUser('Member'); // fixture users start unverified
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);

    await expect(strict.addMember(tenantId, member.email, 'contributor', admin.id)).rejects.toThrow(
      EmailNotVerifiedForMembershipError,
    );
    expect((await service.listMembers(tenantId)).map((m) => m.userId)).not.toContain(member.id);

    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, member.id));
    await strict.addMember(tenantId, member.email, 'contributor', admin.id);
    expect((await service.listMembers(tenantId)).map((m) => m.userId)).toContain(member.id);
  });

  it('updates a member role', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);
    await service.addMember(tenantId, member.email, 'contributor', admin.id);

    await service.updateMemberRole(tenantId, member.id, 'publisher', admin.id);
    const members = await service.listMembers(tenantId);
    expect(members.find((m) => m.userId === member.id)?.role).toBe('publisher');
  });

  it('rejects updating a role for a non-existent membership', async () => {
    const admin = await createUser('Admin');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);

    await expect(
      service.updateMemberRole(tenantId, randomUUID(), 'publisher', admin.id),
    ).rejects.toThrow(MembershipNotFoundError);
  });

  it('removes a member', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);
    await service.addMember(tenantId, member.email, 'contributor', admin.id);

    await service.removeMember(tenantId, member.id, admin.id);
    const members = await service.listMembers(tenantId);
    expect(members.find((m) => m.userId === member.id)).toBeUndefined();
  });

  it('records an audit entry when a member is added and their role is changed', async () => {
    const admin = await createUser('Admin');
    const member = await createUser('Member');
    const { tenantId } = await service.createTenant('Test Tenant', `t-${randomUUID()}`, admin.id);
    fixtures.trackTenant(tenantId);

    await service.addMember(tenantId, member.email, 'contributor', admin.id);
    await service.updateMemberRole(tenantId, member.id, 'publisher', admin.id);

    const auditService = new AuditService(db);
    const entries = await auditService.listForTenant(tenantId, { resourceType: 'Membership' });
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['AddMember', 'UpdateMemberRole']),
    );
    expect(entries.every((e) => e.userId === admin.id)).toBe(true);
    expect(entries.find((e) => e.action === 'UpdateMemberRole')?.resourceId).toBe(member.id);
  });

  describe('tenant governance', () => {
    async function tenantWithAdmin(adminName = 'Admin') {
      const admin = await createUser(adminName);
      const { tenantId } = await service.createTenant('Governed', `g-${randomUUID()}`, admin.id);
      fixtures.trackTenant(tenantId);
      return { tenantId, admin };
    }

    async function roleOf(tenantId: string, userId: string) {
      return (await service.listMembers(tenantId)).find((m) => m.userId === userId)?.role;
    }

    it('refuses to remove or demote the only Tenant Admin, and allows it once another exists', async () => {
      const { tenantId, admin } = await tenantWithAdmin();

      await expect(service.removeMember(tenantId, admin.id, admin.id)).rejects.toThrow(
        LastTenantAdminError,
      );
      await expect(
        service.updateMemberRole(tenantId, admin.id, 'viewer', admin.id),
      ).rejects.toThrow(LastTenantAdminError);
      expect(await roleOf(tenantId, admin.id)).toBe('tenant_admin');

      const second = await createUser('Second admin');
      await service.addMember(tenantId, second.email, 'tenant_admin', admin.id);
      await service.updateMemberRole(tenantId, admin.id, 'viewer', admin.id);
      expect(await roleOf(tenantId, admin.id)).toBe('viewer');
      // `second` is now the only Tenant Admin again.
      await expect(service.removeMember(tenantId, second.id, second.id)).rejects.toThrow(
        LastTenantAdminError,
      );
      expect(await roleOf(tenantId, second.id)).toBe('tenant_admin');
    });

    it('lets only one of two concurrent demotions through when they are the last two Tenant Admins', async () => {
      const { tenantId, admin } = await tenantWithAdmin('Admin A');
      const other = await createUser('Admin B');
      await service.addMember(tenantId, other.email, 'tenant_admin', admin.id);

      const results = await Promise.allSettled([
        service.updateMemberRole(tenantId, admin.id, 'viewer', admin.id),
        service.removeMember(tenantId, other.id, other.id),
      ]);

      const refused = results.filter((r) => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastTenantAdminError);
      const admins = (await service.listMembers(tenantId)).filter((m) => m.role === 'tenant_admin');
      expect(admins).toHaveLength(1);
    });

    it("drops a removed member's reviewer requests on pending proposals only, and audits the count", async () => {
      const { tenantId, admin } = await tenantWithAdmin();
      const member = await createUser('Reviewer');
      await service.addMember(tenantId, member.email, 'contributor', admin.id);
      const proposals = new ProposalService(db);
      const newProposal = () =>
        proposals.createPending({
          tenantId,
          serviceId: 'svc-governance',
          environment: 'test',
          proposedByUserId: admin.id,
          changes: {},
          queuedDiff: [],
          correlationId: randomUUID(),
        });
      const pending = await newProposal();
      const decided = await newProposal();
      await proposals.markResolved(tenantId, decided.id, 'rejected', admin.id);
      await proposals.addReviewers(tenantId, pending.id, [member.id], admin.id);
      await proposals.addReviewers(tenantId, decided.id, [member.id], admin.id);

      await service.removeMember(tenantId, member.id, admin.id);

      expect(await proposals.listReviewers(tenantId, pending.id)).toEqual([]);
      expect(await proposals.listReviewers(tenantId, decided.id)).toEqual([
        expect.objectContaining({ userId: member.id }),
      ]);
      const removal = (
        await new AuditService(db).listForTenant(tenantId, { resourceType: 'Membership' })
      ).find((e) => e.action === 'RemoveMember');
      expect(removal?.afterState).toEqual({ droppedReviewerRequests: 1 });
    });

    it('leaves a reviewer who is no longer a member out of the membersOnly list', async () => {
      const { tenantId, admin } = await tenantWithAdmin();
      const member = await createUser('Departed');
      await service.addMember(tenantId, member.email, 'contributor', admin.id);
      const proposals = new ProposalService(db);
      const pending = await proposals.createPending({
        tenantId,
        serviceId: 'svc-governance',
        environment: 'test',
        proposedByUserId: admin.id,
        changes: {},
        queuedDiff: [],
        correlationId: randomUUID(),
      });
      await proposals.addReviewers(tenantId, pending.id, [member.id], admin.id);
      // Membership gone without the reviewer row being dropped.
      await withContext(db, { tenantId }, (tx) =>
        tx
          .delete(memberships)
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, member.id))),
      );

      expect(await proposals.listReviewers(tenantId, pending.id)).toHaveLength(1);
      expect(await proposals.listReviewers(tenantId, pending.id, { membersOnly: true })).toEqual(
        [],
      );
    });

    it('audits a refused add as NotApplied without the email, and still throws the service error', async () => {
      const { tenantId, admin } = await tenantWithAdmin();
      const auditService = new AuditService(db);

      await expect(
        service.addMember(tenantId, 'nobody@example.test', 'contributor', admin.id),
      ).rejects.toThrow(UserNotFoundError);

      const refused = (
        await auditService.listForTenant(tenantId, { resourceType: 'Membership' })
      ).find((e) => e.result === 'NotApplied');
      expect(refused).toMatchObject({
        action: 'AddMember',
        resourceId: null,
        afterState: { role: 'contributor', reason: 'UnknownEmail' },
      });
      expect(JSON.stringify(refused)).not.toContain('nobody@example.test');
    });

    it('audits an add refused for an unverified email, naming the account it refers to', async () => {
      const strict = new TenantService(db, new AuditService(db), { requireVerifiedEmail: true });
      const { tenantId, admin } = await tenantWithAdmin();
      const member = await createUser('Unverified');

      await expect(strict.addMember(tenantId, member.email, 'approver', admin.id)).rejects.toThrow(
        EmailNotVerifiedForMembershipError,
      );

      const refused = (
        await new AuditService(db).listForTenant(tenantId, { resourceType: 'Membership' })
      ).find((e) => e.result === 'NotApplied');
      expect(refused).toMatchObject({
        resourceId: member.id,
        afterState: { role: 'approver', reason: 'EmailNotVerified' },
      });
    });
  });

  describe('createTenantWithAdmin (tenant:create)', () => {
    it('creates the tenant with the existing account as its Tenant Admin, matching the email ignoring case', async () => {
      const admin = await createUser('Operator-made admin');
      const slug = `cli-${randomUUID()}`;

      const { tenantId, adminUserId } = await createTenantWithAdmin(db, service, {
        name: 'CLI tenant',
        slug,
        adminEmail: admin.email.toUpperCase(),
      });
      fixtures.trackTenant(tenantId);

      expect(adminUserId).toBe(admin.id);
      expect(await service.listTenantsForUser(admin.id)).toEqual([
        { tenantId, tenantName: 'CLI tenant', tenantSlug: slug, role: 'tenant_admin' },
      ]);
    });

    it('refuses an email with no account and creates nothing', async () => {
      const slug = `cli-${randomUUID()}`;

      await expect(
        createTenantWithAdmin(db, service, {
          name: 'Nobody',
          slug,
          adminEmail: 'nobody@example.test',
        }),
      ).rejects.toThrow('No account is registered with nobody@example.test');
      const found = await db.select().from(tenants).where(eq(tenants.slug, slug));
      expect(found).toHaveLength(0);
    });
  });
});

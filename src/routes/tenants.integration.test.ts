import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, users } from '../db/schema/index.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';

describe('tenant routes', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const fixtures = new IntegrationFixtures(db, config);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => fixtures.cleanup());

  async function createUserWithToken(): Promise<{ id: string; email: string; token: string }> {
    const id = await fixtures.user('Route Test');
    return { id, email: `${id}@example.test`, token: await fixtures.webToken(id) };
  }

  it('creates a tenant via HTTP and lists it back for the creator', async () => {
    const user = await createUserWithToken();
    const slug = `tenant-${randomUUID()}`;

    const createRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'Route Tenant', slug },
    });
    expect(createRes.statusCode).toBe(201);
    const { tenantId } = createRes.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);

    const listRes = await app.inject({
      method: 'GET',
      url: '/tenants',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual([
      { tenantId, tenantName: 'Route Tenant', tenantSlug: slug, role: 'tenant_admin' },
    ]);
  });

  it('rejects an unknown or retired role name with 400', async () => {
    const admin = await createUserWithToken();
    const member = await createUserWithToken();
    const createRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Role Tenant', slug: `role-${randomUUID()}` },
    });
    const { tenantId } = createRes.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: member.email, role: 'reader' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('viewer, contributor, approver, publisher, tenant_admin');
  });

  it('rejects tenant creation without authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tenants',
      payload: { name: 'X', slug: `x-${randomUUID()}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets a tenant_admin add a member, and blocks a reader from doing the same', async () => {
    const admin = await createUserWithToken();
    const reader = await createUserWithToken();
    const newMember = await createUserWithToken();
    const slug = `tenant-${randomUUID()}`;

    const createRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Route Tenant', slug },
    });
    const { tenantId } = createRes.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);

    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: reader.email, role: 'contributor' },
    });

    const forbiddenRes = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { email: newMember.email, role: 'approver' },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const addRes = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: newMember.email, role: 'approver' },
    });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.json()).toEqual({
      message: 'If an account with that email exists and is eligible, it has been added.',
    });

    const membersRes = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(membersRes.json()).toHaveLength(3);
  });

  it('defaults four-eyes on, lets members read it and only a tenant_admin change it', async () => {
    const admin = await createUserWithToken();
    const viewer = await createUserWithToken();
    const createRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Settings Tenant', slug: `tenant-${randomUUID()}` },
    });
    const { tenantId } = createRes.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);
    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: viewer.email, role: 'viewer' },
    });

    const asViewer = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/settings`,
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json()).toEqual({ requireFourEyes: true });

    const forbidden = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/settings`,
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { requireFourEyes: false },
    });
    expect(forbidden.statusCode).toBe(403);

    const invalid = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/settings`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { requireFourEyes: 'no' },
    });
    expect(invalid.statusCode).toBe(400);

    const updated = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/settings`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { requireFourEyes: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ requireFourEyes: false });

    const audit = await withContext(db, { tenantId }, async (tx) =>
      tx.select().from(auditEntries).where(eq(auditEntries.tenantId, tenantId)),
    );
    expect(audit.map((entry) => entry.action)).toContain('UpdateTenantSettings');
  });

  it('updates and then removes a member via HTTP', async () => {
    const admin = await createUserWithToken();
    const member = await createUserWithToken();
    const slug = `tenant-${randomUUID()}`;

    const createRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Route Tenant', slug },
    });
    const { tenantId } = createRes.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);

    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: member.email, role: 'contributor' },
    });

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/tenants/${tenantId}/members/${member.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { role: 'publisher' },
    });
    expect(patchRes.statusCode).toBe(204);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/tenants/${tenantId}/members/${member.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(deleteRes.statusCode).toBe(204);

    const membersRes = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(membersRes.json()).toHaveLength(1);
  });

  it('answers 403 to tenant creation when ALLOW_TENANT_CREATION is off, and creates nothing', async () => {
    const user = await createUserWithToken();
    const closed = await buildApp({
      config: { ...config, logLevel: 'silent', allowTenantCreation: false },
      db,
    });
    try {
      const slug = `closed-${randomUUID()}`;
      const res = await closed.inject({
        method: 'POST',
        url: '/tenants',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { name: 'Closed', slug },
      });
      expect(res.statusCode).toBe(403);
      const listed = await app.inject({
        method: 'GET',
        url: '/tenants',
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(listed.json()).toEqual([]);
    } finally {
      await closed.close();
    }
  });

  it('answers the same to adding an unknown, an unverified or an eligible email', async () => {
    const admin = await createUserWithToken();
    const unverified = await createUserWithToken();
    const verified = await createUserWithToken();
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, verified.id));
    const strict = await buildApp({
      config: { ...config, logLevel: 'silent', requireVerifiedEmail: true },
      db,
    });
    try {
      const createRes = await strict.inject({
        method: 'POST',
        url: '/tenants',
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name: 'Probe', slug: `probe-${randomUUID()}` },
      });
      const { tenantId } = createRes.json() as { tenantId: string };
      fixtures.trackTenant(tenantId);

      const answers = [];
      for (const email of [
        `unknown-${randomUUID()}@example.test`,
        unverified.email,
        verified.email,
      ]) {
        const res = await strict.inject({
          method: 'POST',
          url: `/tenants/${tenantId}/members`,
          headers: { authorization: `Bearer ${admin.token}` },
          payload: { email, role: 'contributor' },
        });
        answers.push({ status: res.statusCode, body: res.json() });
      }

      expect(answers[0]).toEqual(answers[1]);
      expect(answers[1]).toEqual(answers[2]);
      expect(answers[0]!.status).toBe(200);
      // Only the eligible account was added.
      const members = await strict.inject({
        method: 'GET',
        url: `/tenants/${tenantId}/members`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect((members.json() as Array<{ userId: string }>).map((m) => m.userId).sort()).toEqual(
        [admin.id, verified.id].sort(),
      );
    } finally {
      await strict.close();
    }
  });

  it('refuses to remove or demote the last Tenant Admin with 409', async () => {
    const admin = await createUserWithToken();
    const createRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Last Admin', slug: `last-${randomUUID()}` },
    });
    const { tenantId } = createRes.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);
    const expected = 'The tenant must keep at least one Tenant Admin';

    const demote = await app.inject({
      method: 'PATCH',
      url: `/tenants/${tenantId}/members/${admin.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().message).toContain(expected);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/tenants/${tenantId}/members/${admin.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().message).toContain(expected);
  });
});

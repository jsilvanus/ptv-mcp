import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships, tenants, users } from '../db/schema/index.js';
import { signAccessToken } from '../auth/jwt.js';

describe('tenant routes', () => {
  const config = loadConfig();
  let app: FastifyInstance;
  let db: Database;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    db = createDatabase(config.databaseUrl);
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
  });

  afterAll(async () => {
    await app.close();
  });

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

  async function createUserWithToken(): Promise<{ id: string; email: string; token: string }> {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await db.insert(users).values({ id, email, name: 'Route Test', passwordHash: 'x' });
    createdUserIds.push(id);
    const token = await signAccessToken({ sub: id }, config.jwtSecret);
    return { id, email, token };
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
    createdTenantIds.push(tenantId);

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
    createdTenantIds.push(tenantId);

    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: reader.email, role: 'reader' },
    });

    const forbiddenRes = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { email: newMember.email, role: 'editor' },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const addRes = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: newMember.email, role: 'editor' },
    });
    expect(addRes.statusCode).toBe(204);

    const membersRes = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(membersRes.json()).toHaveLength(3);
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
    createdTenantIds.push(tenantId);

    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: member.email, role: 'reader' },
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
});

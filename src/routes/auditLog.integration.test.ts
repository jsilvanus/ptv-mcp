import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, tenants, users } from '../db/schema/index.js';
import { AuditService } from '../audit/auditService.js';
import { signAccessToken } from '../auth/jwt.js';

describe('audit log routes', () => {
  const config = loadConfig();
  let app: FastifyInstance;
  let db: Database;
  let auditService: AuditService;
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    db = createDatabase(config.databaseUrl);
    auditService = new AuditService(db);
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    for (const tenantId of createdTenantIds) {
      await withContext(db, { tenantId }, async (tx) => {
        await tx.delete(auditEntries).where(eq(auditEntries.tenantId, tenantId));
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

  async function setUp(role: 'reader' | 'tenant_admin') {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: 'Audit Route Test', slug: `art-${tenantId}` });
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Test', passwordHash: 'x' });
    createdTenantIds.push(tenantId);
    createdUserIds.push(userId);
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values({ tenantId, userId, role });
    });
    const token = await signAccessToken({ sub: userId }, config.jwtSecret);
    return { tenantId, userId, token };
  }

  it('returns audit entries for a tenant_admin', async () => {
    const { tenantId, userId, token } = await setUp('tenant_admin');
    await auditService.record({
      tenantId,
      userId,
      action: 'ProposeServiceChange',
      resourceType: 'Service',
      resourceId: 'svc-1',
      result: 'Proposed',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/audit-entries`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ action: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.action).toBe('ProposeServiceChange');
  });

  it('rejects a reader (audit log viewing is a tenant_admin capability)', async () => {
    const { tenantId, token } = await setUp('reader');
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/audit-entries`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const { tenantId } = await setUp('tenant_admin');
    const res = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/audit-entries` });
    expect(res.statusCode).toBe(401);
  });

  it('filters by resourceType and respects limit', async () => {
    const { tenantId, userId, token } = await setUp('tenant_admin');
    await auditService.record({
      tenantId,
      userId,
      action: 'A',
      resourceType: 'Service',
      result: 'Success',
    });
    await auditService.record({
      tenantId,
      userId,
      action: 'B',
      resourceType: 'Organization',
      result: 'Success',
    });

    const filtered = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/audit-entries?resourceType=Organization`,
      headers: { authorization: `Bearer ${token}` },
    });
    const filteredBody = filtered.json() as Array<{ resourceType: string }>;
    expect(filteredBody).toHaveLength(1);
    expect(filteredBody[0]?.resourceType).toBe('Organization');

    const limited = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/audit-entries?limit=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((limited.json() as unknown[]).length).toBe(1);
  });
});

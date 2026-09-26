import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { AuditService } from '../audit/auditService.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';

describe('audit log routes', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const auditService = new AuditService(db);
  const fixtures = new IntegrationFixtures(db, config);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => fixtures.cleanup());

  async function setUp(role: 'contributor' | 'tenant_admin') {
    const tenantId = await fixtures.tenant({ name: 'Audit Route Test', slugPrefix: 'art' });
    const userId = await fixtures.user();
    await fixtures.addMembership(tenantId, userId, role);
    const token = await fixtures.webToken(userId);
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
    const { tenantId, token } = await setUp('contributor');
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

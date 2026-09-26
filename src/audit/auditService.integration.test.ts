import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { AuditService } from './auditService.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';

describe('AuditService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const service = new AuditService(db);
  const fixtures = new IntegrationFixtures(db, config);

  afterEach(() => fixtures.cleanup());

  const createTenant = () => fixtures.tenant({ slugPrefix: 'audit' });

  it('inserts and returns an audit entry with all fields', async () => {
    const tenantId = await createTenant();
    const resourceId = 'res-123';

    const record = await service.record({
      tenantId,
      action: 'CREATE',
      resourceType: 'organization',
      resourceId,
      apiVersion: 'v11',
      environment: 'production',
      beforeState: null,
      afterState: { id: resourceId, name: 'Org 1' },
      prompt: 'Create a new organization',
      result: 'Organization created successfully',
    });

    expect(record).toMatchObject({
      tenantId,
      action: 'CREATE',
      resourceType: 'organization',
      resourceId,
      apiVersion: 'v11',
      environment: 'production',
      result: 'Organization created successfully',
    });
    expect(record.id).toBeDefined();
    expect(record.correlationId).toBeDefined();
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.beforeState).toBeNull();
    expect(record.afterState).toEqual({ id: resourceId, name: 'Org 1' });
    expect(record.userId).toBeNull();
  });

  it('generates a correlationId when not supplied', async () => {
    const tenantId = await createTenant();
    const record1 = await service.record({
      tenantId,
      action: 'PROPOSE',
      resourceType: 'credential',
      result: 'Proposal created',
    });

    const record2 = await service.record({
      tenantId,
      action: 'VALIDATE',
      resourceType: 'credential',
      result: 'Validation passed',
    });

    expect(record1.correlationId).toBeDefined();
    expect(record2.correlationId).toBeDefined();
    expect(record1.correlationId).not.toBe(record2.correlationId);
  });

  it('uses a supplied correlationId instead of generating one', async () => {
    const tenantId = await createTenant();
    const correlationId = randomUUID();

    const record = await service.record({
      tenantId,
      action: 'APPLY',
      resourceType: 'credential',
      result: 'Credential applied',
      correlationId,
    });

    expect(record.correlationId).toBe(correlationId);
  });

  it('groups entries by correlationId in listByCorrelationId in chronological order', async () => {
    const tenantId = await createTenant();
    const correlationId = randomUUID();

    const record1 = await service.record({
      tenantId,
      action: 'PROPOSE',
      resourceType: 'credential',
      result: 'Step 1',
      correlationId,
    });

    const record2 = await service.record({
      tenantId,
      action: 'VALIDATE',
      resourceType: 'credential',
      result: 'Step 2',
      correlationId,
    });

    const record3 = await service.record({
      tenantId,
      action: 'APPLY',
      resourceType: 'credential',
      result: 'Step 3',
      correlationId,
    });

    const entries = await service.listByCorrelationId(tenantId, correlationId);

    expect(entries).toHaveLength(3);
    expect(entries[0]?.id).toBe(record1.id);
    expect(entries[1]?.id).toBe(record2.id);
    expect(entries[2]?.id).toBe(record3.id);
    expect(entries[0]!.createdAt.getTime()).toBeLessThanOrEqual(entries[1]!.createdAt.getTime());
    expect(entries[1]!.createdAt.getTime()).toBeLessThanOrEqual(entries[2]!.createdAt.getTime());
  });

  it('enforces RLS tenant isolation via withContext', async () => {
    const tenant1Id = await createTenant();
    const tenant2Id = await createTenant();

    await service.record({
      tenantId: tenant1Id,
      action: 'CREATE',
      resourceType: 'org',
      result: 'Tenant 1 entry',
    });

    await service.record({
      tenantId: tenant2Id,
      action: 'CREATE',
      resourceType: 'org',
      result: 'Tenant 2 entry',
    });

    const tenant1Entries = await service.listForTenant(tenant1Id);
    const tenant2Entries = await service.listForTenant(tenant2Id);

    expect(tenant1Entries).toHaveLength(1);
    expect(tenant2Entries).toHaveLength(1);
    expect(tenant1Entries[0]?.tenantId).toBe(tenant1Id);
    expect(tenant2Entries[0]?.tenantId).toBe(tenant2Id);
    expect(tenant1Entries[0]?.result).toBe('Tenant 1 entry');
    expect(tenant2Entries[0]?.result).toBe('Tenant 2 entry');
  });

  it('filters listForTenant by resourceType', async () => {
    const tenantId = await createTenant();

    await service.record({
      tenantId,
      action: 'CREATE',
      resourceType: 'organization',
      result: 'Org created',
    });

    await service.record({
      tenantId,
      action: 'CREATE',
      resourceType: 'credential',
      result: 'Cred created',
    });

    await service.record({
      tenantId,
      action: 'UPDATE',
      resourceType: 'organization',
      result: 'Org updated',
    });

    const orgEntries = await service.listForTenant(tenantId, { resourceType: 'organization' });
    const credEntries = await service.listForTenant(tenantId, { resourceType: 'credential' });

    expect(orgEntries).toHaveLength(2);
    expect(credEntries).toHaveLength(1);
    expect(orgEntries.every((e) => e.resourceType === 'organization')).toBe(true);
    expect(credEntries.every((e) => e.resourceType === 'credential')).toBe(true);
  });

  it('respects the limit option in listForTenant', async () => {
    const tenantId = await createTenant();

    for (let i = 0; i < 5; i++) {
      await service.record({
        tenantId,
        action: 'CREATE',
        resourceType: 'resource',
        result: `Entry ${i}`,
      });
    }

    const allEntries = await service.listForTenant(tenantId, { limit: 100 });
    const limitedEntries = await service.listForTenant(tenantId, { limit: 2 });

    expect(allEntries).toHaveLength(5);
    expect(limitedEntries).toHaveLength(2);
  });

  it('defaults to limit 100 in listForTenant', async () => {
    const tenantId = await createTenant();

    for (let i = 0; i < 50; i++) {
      await service.record({
        tenantId,
        action: 'CREATE',
        resourceType: 'resource',
        result: `Entry ${i}`,
      });
    }

    const entries = await service.listForTenant(tenantId);

    expect(entries).toHaveLength(50);
  });

  it('orders listForTenant by createdAt descending', async () => {
    const tenantId = await createTenant();

    const record1 = await service.record({
      tenantId,
      action: 'CREATE',
      resourceType: 'resource',
      result: 'First',
    });

    const record2 = await service.record({
      tenantId,
      action: 'CREATE',
      resourceType: 'resource',
      result: 'Second',
    });

    const record3 = await service.record({
      tenantId,
      action: 'CREATE',
      resourceType: 'resource',
      result: 'Third',
    });

    const entries = await service.listForTenant(tenantId);

    expect(entries).toHaveLength(3);
    expect(entries[0]?.id).toBe(record3.id);
    expect(entries[1]?.id).toBe(record2.id);
    expect(entries[2]?.id).toBe(record1.id);
  });
});

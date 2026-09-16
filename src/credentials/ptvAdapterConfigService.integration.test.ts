import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import { PtvAdapterConfigService } from './ptvAdapterConfigService.js';

describe('PtvAdapterConfigService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const service = new PtvAdapterConfigService(db);
  const createdTenantIds: string[] = [];

  afterEach(async () => {
    for (const id of createdTenantIds) {
      await db.delete(tenants).where(eq(tenants.id, id));
    }
    createdTenantIds.length = 0;
  });

  async function createTenant(): Promise<string> {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: 'Test Tenant', slug: `pac-${id}` });
    createdTenantIds.push(id);
    return id;
  }

  it('upserts and reads back a config for a tenant/environment/version', async () => {
    const tenantId = await createTenant();
    await service.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    const config = await service.get(tenantId, 'production', 'v11');
    expect(config).toMatchObject({
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
  });

  it('returns undefined for a config that has not been set', async () => {
    const tenantId = await createTenant();
    const config = await service.get(tenantId, 'test', 'v12');
    expect(config).toBeUndefined();
  });

  it('updates an existing config in place on re-upsert', async () => {
    const tenantId = await createTenant();
    await service.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });
    await service.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    const configs = await service.list(tenantId);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.supportsWrite).toBe(true);
  });

  it('lists every config for a tenant across environments/versions', async () => {
    const tenantId = await createTenant();
    await service.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    await service.upsert(tenantId, 'test', 'v12', {
      authMode: 'api_key',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const configs = await service.list(tenantId);
    expect(configs).toHaveLength(2);
  });
});

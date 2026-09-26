import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { Organization } from '../ptv/domain.js';
import { createDatabase, type Database } from './client.js';
import { withContext } from './context.js';
import { PtvOrganizationCacheService } from './ptvOrganizationCacheService.js';
import { ptvOrganizationCache, tenants } from './schema/index.js';

describe('PtvOrganizationCacheService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const service = new PtvOrganizationCacheService(db);
  const createdTenantIds: string[] = [];

  afterEach(async () => {
    for (const id of createdTenantIds) {
      await withContext(db, { tenantId: id }, async (tx) => {
        await tx.delete(ptvOrganizationCache).where(eq(ptvOrganizationCache.tenantId, id));
      });
      await db.delete(tenants).where(eq(tenants.id, id));
    }
    createdTenantIds.length = 0;
  });

  async function createTenant(): Promise<string> {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: 'Test Tenant', slug: `orgcache-${id}` });
    createdTenantIds.push(id);
    return id;
  }

  const parish: Organization = {
    id: randomUUID(),
    publishingStatus: 'Published',
    names: { fi: 'Riihimäen seurakunta', sv: 'Riihimäki församling' },
    alternativeNames: { fi: 'Seurakuntayhtymä' },
    modifiedAt: '2026-09-01T00:00:00.000Z',
  };

  it('stores domain organisations and searches official and alternative names', async () => {
    const tenantId = await createTenant();
    const key = { tenantId, environment: 'test', apiVersion: 'v12' } as const;
    expect(await service.hasFreshCatalogue(key)).toBe(false);

    await service.replaceCatalogue(key, [parish]);

    expect(await service.hasFreshCatalogue(key)).toBe(true);
    expect(await service.search(key)).toEqual([parish]);
    expect(await service.search(key, 'församling')).toEqual([parish]);
    expect(await service.search(key, 'seurakuntayhtymä')).toEqual([parish]);
    expect(await service.search(key, 'hämeenlinna')).toEqual([]);
    // Keyed by API version: the v11 catalogue is separate.
    expect(await service.hasFreshCatalogue({ ...key, apiVersion: 'v11' })).toBe(false);
  });

  it('treats rows holding a v11 wire object as stale until they are replaced', async () => {
    const tenantId = await createTenant();
    const key = { tenantId, environment: 'test', apiVersion: 'v11' } as const;
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(ptvOrganizationCache).values({
        tenantId,
        environment: 'test',
        apiVersion: 'v11',
        organizationId: parish.id,
        catalogOrder: 0,
        name: 'Riihimäen seurakunta',
        normalizedName: 'riihimäen seurakunta',
        organization: {
          id: parish.id,
          organizationNames: [{ language: 'fi', value: 'Riihimäen seurakunta', type: 'Name' }],
        },
        staleAt: new Date(Date.now() + 60_000),
      });
    });

    expect(await service.hasFreshCatalogue(key)).toBe(false);
    expect(await service.search(key, 'riihimäen')).toEqual([]);

    await service.replaceCatalogue(key, [parish]);
    expect(await service.hasFreshCatalogue(key)).toBe(true);
    expect(await service.search(key, 'riihimäen')).toEqual([parish]);
  });
});

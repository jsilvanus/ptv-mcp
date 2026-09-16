import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import {
  TenantEnvironmentNotFoundError,
  TenantEnvironmentService,
} from './tenantEnvironmentService.js';

describe('TenantEnvironmentService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const masterKey = randomBytes(32).toString('base64');
  const service = new TenantEnvironmentService(db, masterKey);
  const createdTenantIds: string[] = [];

  afterEach(async () => {
    for (const id of createdTenantIds) {
      await db.delete(tenants).where(eq(tenants.id, id));
    }
    createdTenantIds.length = 0;
  });

  async function createTenant(): Promise<string> {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: 'Test Tenant', slug: `tenv-${id}` });
    createdTenantIds.push(id);
    return id;
  }

  it('stores and decrypts a credentials object', async () => {
    const tenantId = await createTenant();
    await service.storeCredentials(tenantId, 'production', 'v12', { apiKey: 'super-secret-key' });

    const decrypted = await service.getDecryptedCredentials(tenantId, 'production', 'v12');
    expect(decrypted).toEqual({ apiKey: 'super-secret-key' });
  });

  it('throws for credentials that were never configured', async () => {
    const tenantId = await createTenant();
    await expect(service.getDecryptedCredentials(tenantId, 'production', 'v12')).rejects.toThrow(
      TenantEnvironmentNotFoundError,
    );
  });

  it('treats a deactivated environment as not found', async () => {
    const tenantId = await createTenant();
    await service.storeCredentials(tenantId, 'test', 'v12', { apiKey: 'key' });
    await service.deactivate(tenantId, 'test', 'v12');

    await expect(service.getDecryptedCredentials(tenantId, 'test', 'v12')).rejects.toThrow(
      TenantEnvironmentNotFoundError,
    );
  });

  it('keeps test and production credentials independent for the same tenant', async () => {
    const tenantId = await createTenant();
    await service.storeCredentials(tenantId, 'test', 'v12', { apiKey: 'test-key' });
    await service.storeCredentials(tenantId, 'production', 'v12', { apiKey: 'prod-key' });

    const test = await service.getDecryptedCredentials(tenantId, 'test', 'v12');
    const prod = await service.getDecryptedCredentials(tenantId, 'production', 'v12');
    expect(test).toEqual({ apiKey: 'test-key' });
    expect(prod).toEqual({ apiKey: 'prod-key' });
  });

  it('replaces credentials on re-store (key rotation)', async () => {
    const tenantId = await createTenant();
    await service.storeCredentials(tenantId, 'production', 'v12', { apiKey: 'old-key' });
    await service.storeCredentials(tenantId, 'production', 'v12', { apiKey: 'new-key' });

    const decrypted = await service.getDecryptedCredentials(tenantId, 'production', 'v12');
    expect(decrypted).toEqual({ apiKey: 'new-key' });
  });
});

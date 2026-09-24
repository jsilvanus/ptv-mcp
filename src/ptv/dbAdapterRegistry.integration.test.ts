import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships, tenants, users } from '../db/schema/index.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { TenantEnvironmentService } from '../credentials/tenantEnvironmentService.js';
import { UserPtvConnectionService } from '../credentials/userPtvConnectionService.js';
import { InMemoryPtvAdapter } from './testing/inMemoryAdapter.js';
import { PtvAdapterResolutionError } from './registry.js';
import { DbPtvAdapterRegistry, type AdapterConstructionOptions } from './dbAdapterRegistry.js';

describe('DbPtvAdapterRegistry', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const masterKey = randomBytes(32).toString('base64');

  const configService = new PtvAdapterConfigService(db);
  const tenantEnvironmentService = new TenantEnvironmentService(db, masterKey);
  const userConnectionService = new UserPtvConnectionService(db, masterKey);

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

  async function setUp(role: 'contributor' | 'approver' | 'publisher' | 'tenant_admin') {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: 'Registry Test', slug: `reg-${tenantId}` });
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Test', passwordHash: 'x' });
    createdTenantIds.push(tenantId);
    createdUserIds.push(userId);
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values({ tenantId, userId, role });
    });
    return { tenantId, userId };
  }

  function buildRegistry(
    adapterFactories?: Record<string, (options: AdapterConstructionOptions) => InMemoryPtvAdapter>,
  ) {
    return new DbPtvAdapterRegistry(
      db,
      configService,
      tenantEnvironmentService,
      userConnectionService,
      adapterFactories,
    );
  }

  it('rejects a reader attempting a write (not_authorized before any credential lookup)', async () => {
    const { tenantId, userId } = await setUp('contributor');
    await configService.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    const registry = buildRegistry();
    await expect(
      registry.resolve({
        tenantId,
        environment: 'production',
        apiVersion: 'v11',
        operation: 'write',
        actingUserId: userId,
      }),
    ).rejects.toMatchObject({
      reason: 'not_authorized',
    } satisfies Partial<PtvAdapterResolutionError>);
  });

  it('rejects a user with no membership in the tenant at all', async () => {
    const { tenantId } = await setUp('publisher');
    const outsiderId = randomUUID();
    await db.insert(users).values({
      id: outsiderId,
      email: `${outsiderId}@example.test`,
      name: 'Outsider',
      passwordHash: 'x',
    });
    createdUserIds.push(outsiderId);
    await configService.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const registry = buildRegistry();
    await expect(
      registry.resolve({
        tenantId,
        environment: 'production',
        apiVersion: 'v11',
        operation: 'read',
        actingUserId: outsiderId,
      }),
    ).rejects.toMatchObject({ reason: 'not_authorized' });
  });

  it('throws no_adapter_configured when nothing is configured for the tenant/environment', async () => {
    const { tenantId, userId } = await setUp('publisher');
    const registry = buildRegistry();
    await expect(
      registry.resolve({
        tenantId,
        environment: 'production',
        apiVersion: 'v11',
        operation: 'read',
        actingUserId: userId,
      }),
    ).rejects.toMatchObject({ reason: 'no_adapter_configured' });
  });

  it('throws operation_not_supported when the configured adapter cannot write', async () => {
    const { tenantId, userId } = await setUp('publisher');
    await configService.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const registry = buildRegistry();
    await expect(
      registry.resolve({
        tenantId,
        environment: 'production',
        apiVersion: 'v11',
        operation: 'write',
        actingUserId: userId,
      }),
    ).rejects.toMatchObject({ reason: 'operation_not_supported' });
  });

  it('throws credential_missing_or_expired for a write when the user has no PTV connection', async () => {
    const { tenantId, userId } = await setUp('publisher');
    await configService.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    const registry = buildRegistry();
    await expect(
      registry.resolve({
        tenantId,
        environment: 'production',
        apiVersion: 'v11',
        operation: 'write',
        actingUserId: userId,
      }),
    ).rejects.toMatchObject({ reason: 'credential_missing_or_expired' });
  });

  it('resolves public v11 OUT without a tenant or membership', async () => {
    const registry = buildRegistry();
    const adapter = await registry.resolve({
      environment: 'test',
      apiVersion: 'v11',
      operation: 'read',
      actingUserId: randomUUID(),
    });
    expect(adapter.getCapabilities()).toMatchObject({
      apiVersion: 'v11',
      environment: 'test',
      supportsRead: true,
    });
  });

  it('resolves a real PtvV11Adapter for a read with no connection stored, and it can make a real live call', async () => {
    const { tenantId, userId } = await setUp('contributor');
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const registry = buildRegistry();
    const adapter = await registry.resolve({
      tenantId,
      environment: 'test',
      apiVersion: 'v11',
      operation: 'read',
      actingUserId: userId,
    });
    expect(adapter.getCapabilities().apiVersion).toBe('v11');

    // Real, live call against PTV's test environment — v11's ordinary
    // reads need no credential at all (docs/ptv-v11-notes.md), so this
    // must succeed even though no UserPtvConnection was ever stored.
    const result = await adapter.searchServices({ page: 1, pageSize: 1 });
    expect(result.items.length).toBeGreaterThanOrEqual(0);
  });

  it('decrypts a stored user connection and passes its exact access token to the adapter factory', async () => {
    const { tenantId, userId } = await setUp('publisher');
    await configService.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    await userConnectionService.storeConnection(
      userId,
      'v11',
      'production',
      'the-real-token',
      null,
    );

    let capturedToken: string | undefined;
    const registry = buildRegistry({
      v11: (options) => {
        if (options.credential.scope === 'user') {
          capturedToken = options.credential.accessToken;
        }
        return new InMemoryPtvAdapter({
          capabilities: {
            apiVersion: 'v11',
            environment: options.environment,
            credentialScope: 'user',
            supportsRead: true,
            supportsWrite: options.canWrite,
            supportsDraftRead: false,
          },
        });
      },
    });

    await registry.resolve({
      tenantId,
      environment: 'production',
      apiVersion: 'v11',
      operation: 'write',
      actingUserId: userId,
    });
    expect(capturedToken).toBe('the-real-token');
  });

  it('resolves the tenant-scoped credential branch via an injected factory and the in-memory fake', async () => {
    // No real tenant-scoped v11 adapter exists — this proves the
    // *registry's* tenant-scoped resolution path end to end using the
    // Phase 1 in-memory fake, per docs/phase-plan.md's Stream D scope
    // note ("test both credential-scope branches now").
    const { tenantId, userId } = await setUp('publisher');
    await configService.upsert(tenantId, 'production', 'v12-fake-tenant-scoped', {
      authMode: 'api_key',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    await tenantEnvironmentService.storeCredentials(
      tenantId,
      'production',
      'v12-fake-tenant-scoped',
      {
        apiKey: 'tenant-secret-key',
      },
    );

    let capturedCredentials: Record<string, unknown> | undefined;
    const registry = buildRegistry({
      'v12-fake-tenant-scoped': (options) => {
        if (options.credential.scope === 'tenant') {
          capturedCredentials = options.credential.credentials;
        }
        return new InMemoryPtvAdapter({
          capabilities: {
            apiVersion: 'v12-fake-tenant-scoped',
            environment: options.environment,
            credentialScope: 'tenant',
            supportsRead: true,
            supportsWrite: options.canWrite,
            supportsDraftRead: false,
          },
        });
      },
    });

    const adapter = await registry.resolve({
      tenantId,
      environment: 'production',
      apiVersion: 'v12-fake-tenant-scoped',
      operation: 'write',
      actingUserId: userId,
    });
    expect(capturedCredentials).toEqual({ apiKey: 'tenant-secret-key' });
    expect(adapter.getCapabilities().credentialScope).toBe('tenant');
  });

  it('throws credential_missing_or_expired for a tenant-scoped write with no stored credentials', async () => {
    const { tenantId, userId } = await setUp('publisher');
    await configService.upsert(tenantId, 'production', 'v12-fake-tenant-scoped', {
      authMode: 'api_key',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    const registry = buildRegistry({
      'v12-fake-tenant-scoped': (options) =>
        new InMemoryPtvAdapter({
          capabilities: {
            apiVersion: 'v12-fake-tenant-scoped',
            environment: options.environment,
            credentialScope: 'tenant',
            supportsRead: true,
            supportsWrite: options.canWrite,
            supportsDraftRead: false,
          },
        }),
    });

    await expect(
      registry.resolve({
        tenantId,
        environment: 'production',
        apiVersion: 'v12-fake-tenant-scoped',
        operation: 'write',
        actingUserId: userId,
      }),
    ).rejects.toMatchObject({ reason: 'credential_missing_or_expired' });
  });

  it('resolves a write-capable v11 adapter from a tenant-scoped API user', async () => {
    const { tenantId, userId } = await setUp('publisher');
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'api_login',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    await tenantEnvironmentService.storeCredentials(tenantId, 'test', 'v11', {
      username: 'API1@testi.fi',
      password: 'not-a-real-password',
    });

    const adapter = await buildRegistry().resolve({
      tenantId,
      environment: 'test',
      apiVersion: 'v11',
      operation: 'write',
      actingUserId: userId,
    });
    expect(adapter.getCapabilities()).toMatchObject({
      apiVersion: 'v11',
      credentialScope: 'tenant',
      supportsWrite: true,
    });
  });

  it('checkV11Liveness reports live:true against the real test environment', async () => {
    const registry = buildRegistry();
    const result = await registry.checkV11Liveness('test');
    expect(result.live).toBe(true);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });
});

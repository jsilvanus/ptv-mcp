import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, tenants, users } from '../db/schema/index.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { TenantService } from '../tenants/tenantService.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { TenantEnvironmentService } from '../credentials/tenantEnvironmentService.js';
import { UserPtvConnectionService } from '../credentials/userPtvConnectionService.js';
import { DbPtvAdapterRegistry } from '../ptv/dbAdapterRegistry.js';
import { AuditService } from '../audit/auditService.js';

/**
 * Phase 3's stated sync point (docs/phase-plan.md): "integration test —
 * log in, resolve tenant + role, the registry picks `PtvV11Adapter`,
 * credentials decrypt, a real PTV call succeeds, and an audit entry is
 * recorded naming the adapter used." This exercises all four streams
 * (A: auth, B: tenant/credential management, C: audit, D: registry)
 * together, end to end, against real Postgres and PTV's live test
 * environment — not mocks.
 */
describe('Phase 3 sync point', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const masterKey = randomBytes(32).toString('base64');

  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const auditService = new AuditService(db);
  const tenantService = new TenantService(db, auditService);
  const configService = new PtvAdapterConfigService(db);
  const tenantEnvironmentService = new TenantEnvironmentService(db, masterKey);
  const userConnectionService = new UserPtvConnectionService(db, masterKey);
  const registry = new DbPtvAdapterRegistry(
    db,
    configService,
    tenantEnvironmentService,
    userConnectionService,
  );

  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  afterAll(async () => {
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
  });

  it('logs in, resolves tenant+role, resolves PtvV11Adapter with decrypted credentials, makes a real PTV call, and records an audit entry naming the adapter', async () => {
    // 1. Register and log in — a real user, a real password, a real JWT session.
    const email = `sync-point-${randomUUID()}@example.test`;
    const { userId } = await authService.register(
      email,
      'Sync Point Publisher',
      'correct-password',
    );
    createdUserIds.push(userId);
    const session = await authService.login(email, 'correct-password');
    expect(session.accessToken).toBeTruthy();

    // 2. Create a tenant and confirm the user's role resolves correctly for it.
    const { tenantId } = await tenantService.createTenant(
      'Sync Point Tenant',
      `sync-point-${randomUUID()}`,
      userId,
    );
    createdTenantIds.push(tenantId);
    const myTenants = await tenantService.listTenantsForUser(userId);
    expect(myTenants).toContainEqual(expect.objectContaining({ tenantId, role: 'tenant_admin' }));

    // A Tenant Admin is not automatically a Publisher for write purposes in
    // this system's role model, but *is* ranked above Publisher (see
    // src/auth/rbac.ts's ROLE_RANK) — confirm the registry's own role gate
    // (Stream D, independent of tenants.ts's route-level RBAC middleware)
    // accepts a write for this tenant_admin.

    // 3. Wire up PtvV11Adapter as the tenant's configured adapter for the
    // test environment.
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    // 4. Resolve via the registry for a read, with no connection stored yet
    // — tenant + role authorization, then PtvV11Adapter is picked. v11's
    // ordinary reads need no credential at all (docs/ptv-v11-notes.md), so
    // this adapter is genuinely unauthenticated, and a real PTV call
    // against it succeeds against PTV's live test environment.
    const readAdapter = await registry.resolve({
      tenantId,
      environment: 'test',
      apiVersion: 'v11',
      operation: 'read',
      actingUserId: userId,
    });
    const capabilities = readAdapter.getCapabilities();
    expect(capabilities.apiVersion).toBe('v11');
    expect(capabilities.credentialScope).toBe('user');
    const searchResult = await readAdapter.searchServices({ page: 1, pageSize: 1 });
    expect(searchResult).toHaveProperty('items');

    // 5. Store a (fake, since no real OAuth client is registered yet — see
    // EXECUTION_LOG.md) user connection, then resolve for a write — this
    // proves the registry's credential-decryption step specifically:
    // it must decrypt back to exactly the plaintext that was stored.
    // (Deliberately not making a live call with this fake token: doing so
    // surfaced a genuine PTV v11 quirk during this test's own development
    // — a malformed Bearer token 500s even on an otherwise-unauthenticated
    // endpoint, rather than 401ing — now recorded in docs/ptv-v11-notes.md.
    // A real write still needs a real per-user OAuth consent, the one item
    // Phase 2/3 leave open pending PTV client registration.)
    await userConnectionService.storeConnection(
      userId,
      'v11',
      'test',
      'sync-point-fake-token',
      null,
    );
    let capturedToken: string | undefined;
    const registryForWrite = new DbPtvAdapterRegistry(
      db,
      configService,
      tenantEnvironmentService,
      userConnectionService,
      {
        v11: (options) => {
          if (options.credential.scope === 'user') capturedToken = options.credential.accessToken;
          return readAdapter;
        },
      },
    );
    await registryForWrite.resolve({
      tenantId,
      environment: 'test',
      apiVersion: 'v11',
      operation: 'write',
      actingUserId: userId,
    });
    expect(capturedToken).toBe('sync-point-fake-token');

    // 6. Record an audit entry naming the adapter used.
    const entry = await auditService.record({
      tenantId,
      userId,
      action: 'SyncPointCheck',
      resourceType: 'Service',
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      result: 'Success',
    });
    expect(entry.apiVersion).toBe('v11');
    expect(entry.environment).toBe('test');

    const recorded = await auditService.listForTenant(tenantId);
    expect(recorded).toContainEqual(expect.objectContaining({ id: entry.id, apiVersion: 'v11' }));
  });
});

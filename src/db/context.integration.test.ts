import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';
import { withContext } from './context.js';
import { auditEntries, tenants } from './schema/index.js';

/**
 * Confirms `withContext` actually threads `set_config` through drizzle's
 * transaction API against the real `ptv_mcp_app` role — not just that the
 * raw `postgres` client can (rls.integration.test.ts already proves that).
 */
describe('withContext', () => {
  const config = loadConfig();
  const appDatabaseUrl = config.databaseUrl.replace(
    /:\/\/[^:]+:[^@]+@/,
    '://ptv_mcp_app:ptv_mcp_app_dev@',
  );
  const admin = createDatabase(config.databaseUrl);
  const asApp = createDatabase(appDatabaseUrl);
  const tenantId = randomUUID();

  beforeAll(async () => {
    await admin
      .insert(tenants)
      .values({ id: tenantId, name: 'Context Test', slug: `ctx-${tenantId}` });
  });

  afterAll(async () => {
    await withContext(admin, { tenantId }, async (tx) => {
      await tx.delete(auditEntries).where(eq(auditEntries.tenantId, tenantId));
    });
    await admin.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('scopes an insert and read to the given tenant context', async () => {
    await withContext(asApp, { tenantId }, async (tx) => {
      await tx
        .insert(auditEntries)
        .values({ tenantId, action: 'Test', resourceType: 'Service', result: 'Success' });
    });

    const rows = await withContext(asApp, { tenantId }, async (tx) => {
      return tx.select().from(auditEntries).where(eq(auditEntries.tenantId, tenantId));
    });
    expect(rows).toHaveLength(1);
  });

  it('sees nothing without any context set (fail closed)', async () => {
    const rows = await asApp.select().from(auditEntries).where(eq(auditEntries.tenantId, tenantId));
    expect(rows).toHaveLength(0);
  });
});

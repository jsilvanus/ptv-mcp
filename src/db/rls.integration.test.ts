import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

/**
 * Verifies Row-Level Security actually restricts the runtime app role
 * (`ptv_mcp_app`), not just that policies exist — see docs/plan.md's
 * "Multi-tenant-eristys" note and docs/phase-plan.md's Phase 6 isolation
 * tests, which this is the Phase 1 foundation for.
 *
 * Requires a migrated database reachable via DATABASE_URL, with
 * `scripts/bootstrap-roles.sql` already applied (see README / docker
 * compose's automatic bootstrap via docker-entrypoint-initdb.d).
 */
describe('Row-Level Security', () => {
  const config = loadConfig();
  const appDatabaseUrl = config.databaseUrl.replace(
    /:\/\/[^:]+:[^@]+@/,
    '://ptv_mcp_app:ptv_mcp_app_dev@',
  );

  const admin = postgres(config.databaseUrl);
  const asApp = postgres(appDatabaseUrl);

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();

  beforeAll(async () => {
    await admin`INSERT INTO tenants (id, name, slug) VALUES (${tenantA}, 'Tenant A', ${`tenant-a-${tenantA}`})`;
    await admin`INSERT INTO tenants (id, name, slug) VALUES (${tenantB}, 'Tenant B', ${`tenant-b-${tenantB}`})`;
    await admin`INSERT INTO users (id, email, name, password_hash) VALUES (${userA}, ${`${userA}@example.test`}, 'User A', 'x')`;

    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      await tx`INSERT INTO audit_entries (tenant_id, action, resource_type, result) VALUES (${tenantA}, 'Test', 'Service', 'Success')`;
    });
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      await tx`INSERT INTO audit_entries (tenant_id, action, resource_type, result) VALUES (${tenantB}, 'Test', 'Service', 'Success')`;
    });
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${userA}, true)`;
      await tx`INSERT INTO user_ptv_connections (user_id, api_version, environment, encrypted_access_token, encrypted_data_key) VALUES (${userA}, 'v11', 'production', 'enc-token', 'enc-key')`;
    });
  });

  afterAll(async () => {
    // Cleanup runs as `ptv_mcp`, which FORCE ROW LEVEL SECURITY applies to
    // as well — deletes need the same session context as the inserts did,
    // or RLS silently filters them down to zero affected rows.
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      await tx`DELETE FROM audit_entries WHERE tenant_id = ${tenantA}`;
    });
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      await tx`DELETE FROM audit_entries WHERE tenant_id = ${tenantB}`;
    });
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${userA}, true)`;
      await tx`DELETE FROM user_ptv_connections WHERE user_id = ${userA}`;
    });
    await admin`DELETE FROM users WHERE id = ${userA}`;
    await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await admin.end();
    await asApp.end();
  });

  it('denies all rows when no tenant context is set (fail closed)', async () => {
    const rows =
      await asApp`SELECT tenant_id FROM audit_entries WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    expect(rows).toHaveLength(0);
  });

  it('shows only the current tenant’s audit entries once context is set', async () => {
    const rows = await asApp.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      return tx`SELECT tenant_id FROM audit_entries WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(tenantA);
  });

  it('never leaks another tenant’s rows even when both exist', async () => {
    const rowsForB = await asApp.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      return tx`SELECT tenant_id FROM audit_entries WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    });

    expect(rowsForB.map((r) => r.tenant_id)).toEqual([tenantB]);
  });

  it('scopes user_ptv_connections by user, not tenant', async () => {
    const withoutContext =
      await asApp`SELECT user_id FROM user_ptv_connections WHERE user_id = ${userA}`;
    expect(withoutContext).toHaveLength(0);

    const withContext = await asApp.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${userA}, true)`;
      return tx`SELECT user_id FROM user_ptv_connections WHERE user_id = ${userA}`;
    });
    expect(withContext).toHaveLength(1);
  });
});

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, tenants, users } from '../db/schema/index.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { AuditService } from '../audit/auditService.js';

/**
 * Phase 4's stated sync point (docs/phase-plan.md): "end-to-end script —
 * search a real service via v11, propose a rewrite, validate it, then
 * either export it or apply it directly — with every step in the audit
 * log." Runs the actual MCP protocol (a real `Client` over
 * `StreamableHTTPClientTransport`) against real Postgres and PTV's live
 * test environment.
 *
 * Uses "export" as the terminal step, not "apply" — the same gap Phase
 * 2/3 already documented: a real write needs a real per-user PTV OAuth
 * connection, which needs a PTV client actually registered with
 * palveluhallinta.suomi.fi (an external, organization-level prerequisite
 * not available in this session). `ptv_apply_changes` itself is built and
 * unit/integration-tested (src/mcp/applyOrExport.test.ts,
 * dbAdapterRegistry.integration.test.ts's write-capable-adapter
 * resolution) — this script exercises the path MVP-0 actually offers end
 * to end today.
 */
describe('Phase 4 sync point', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const configService = new PtvAdapterConfigService(db);
  const auditService = new AuditService(db);

  // Real, published record in PTV's test environment (confirmed live during
  // Phase 2 — see src/ptv/v11/adapter.integration.test.ts).
  const KNOWN_SERVICE_ID = 'af60add0-c3be-40f6-9c22-3e29c2b8da0a';

  let app: FastifyInstance;
  let baseUrl: string;
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
    await app.close();
  });

  it('searches a real service via v11, proposes a rewrite, validates it, exports it, with every step audited', async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a network address for the listening server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register + log in a real user (Phase 3 Stream A / Phase 4 auth reuse).
    const email = `phase4-sync-${randomUUID()}@example.test`;
    const { userId } = await authService.register(email, 'Phase 4 Sync Point', 'correct-password');
    createdUserIds.push(userId);
    const session = await authService.login(email, 'correct-password');

    // 2. Create a tenant, make this user an Editor (propose/export need Editor+, not just Reader).
    const tenantId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: 'Phase 4 Sync Tenant', slug: `p4-${tenantId}` });
    createdTenantIds.push(tenantId);
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values({ tenantId, userId, role: 'editor' });
    });
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });

    // 3. Connect a real MCP client over the real HTTP transport.
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${session.accessToken}` } },
    });
    const client = new Client({ name: 'phase4-sync-point', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);

    // 4. Search a real service via v11.
    const getResult = await client.callTool({
      name: 'ptv_get_service',
      arguments: { tenantId, environment: 'test', id: KNOWN_SERVICE_ID },
    });
    expect(getResult.isError).not.toBe(true);
    const currentService = JSON.parse((getResult.content as Array<{ text: string }>)[0]!.text) as {
      id: string;
      names: Record<string, string>;
    };
    expect(currentService.id).toBe(KNOWN_SERVICE_ID);

    // 5. Propose a rewrite.
    const proposeResult = await client.callTool({
      name: 'ptv_propose_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: KNOWN_SERVICE_ID,
        changes: { names: { ...currentService.names, fi: 'Phase 4 sync point rewrite' } },
      },
    });
    expect(proposeResult.isError).not.toBe(true);
    const proposal = JSON.parse((proposeResult.content as Array<{ text: string }>)[0]!.text) as {
      proposed: unknown;
      diff: unknown[];
      correlationId: string;
    };
    expect(proposal.diff.length).toBeGreaterThan(0);
    const { correlationId } = proposal;

    // 6. Validate it, in the same audit chain.
    const validateResult = await client.callTool({
      name: 'ptv_validate_changes',
      arguments: { tenantId, environment: 'test', proposed: proposal.proposed, correlationId },
    });
    expect(validateResult.isError).not.toBe(true);
    const validation = JSON.parse((validateResult.content as Array<{ text: string }>)[0]!.text) as {
      valid: boolean;
    };
    expect(validation.valid).toBe(true);

    // 7. Export for manual publish — the terminal step MVP-0 offers without
    // a real per-user PTV OAuth connection (see this file's docstring).
    const exportResult = await client.callTool({
      name: 'ptv_export_for_manual_publish',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: KNOWN_SERVICE_ID,
        changes: { names: { ...currentService.names, fi: 'Phase 4 sync point rewrite' } },
        correlationId,
      },
    });
    expect(exportResult.isError).not.toBe(true);
    const exported = JSON.parse((exportResult.content as Array<{ text: string }>)[0]!.text) as {
      languages: Record<string, { name?: string }>;
    };
    expect(exported.languages.fi?.name).toBe('Phase 4 sync point rewrite');

    await client.close();

    // 8. Confirm every step landed in the audit log, joined by one correlationId.
    const trail = await auditService.listByCorrelationId(tenantId, correlationId);
    expect(trail.map((e) => e.action)).toEqual([
      'ProposeServiceChange',
      'ValidateServiceChange',
      'ProposeServiceChange',
      'ExportForManualPublish',
    ]);
    expect(trail.every((e) => e.correlationId === correlationId)).toBe(true);
    expect(trail.find((e) => e.action === 'ExportForManualPublish')?.result).toBe(
      'ReadyForManualPublish',
    );
  });
});

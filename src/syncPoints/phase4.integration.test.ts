import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { AuditService } from '../audit/auditService.js';
import { IntegrationFixtures, listenLocally } from '../testing/integrationFixtures.js';
import { connectMcpClient, toolJson } from '../testing/mcpClient.js';

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
  const auditService = new AuditService(db);
  const fixtures = new IntegrationFixtures(db, config);

  // Real, published record in PTV's test environment (confirmed live during
  // Phase 2 — see src/ptv/v11/adapter.integration.test.ts).
  const KNOWN_SERVICE_ID = 'af60add0-c3be-40f6-9c22-3e29c2b8da0a';

  let app: FastifyInstance;

  afterAll(async () => {
    await fixtures.cleanup();
    await app.close();
  });

  it('searches a real service via v11, proposes a rewrite, validates it, exports it, with every step audited', async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
    const baseUrl = await listenLocally(app);

    // 1. Register + log in a real user (Phase 3 Stream A / Phase 4 auth reuse).
    const { userId } = await fixtures.registeredUser(
      authService,
      'phase4-sync',
      'Phase 4 Sync Point',
    );

    // 2. Create a tenant, make this user an Editor (propose/export need Editor+, not just Reader).
    const tenantId = await fixtures.tenant({
      name: 'Phase 4 Sync Tenant',
      slugPrefix: 'p4',
      // Exercises the direct export tool, which four-eyes refuses.
      requireFourEyes: false,
      v11: { supportsWrite: true },
    });
    await fixtures.addMembership(tenantId, userId, 'approver');

    // 3. Connect a real MCP client over the real HTTP transport. MCP tools
    // take tenant/environment/api-version from the OAuth token's own
    // claims (toolContext() in src/mcp/tools/shared.ts), not from
    // AuthService's web-session JWT (session.accessToken has none of those
    // claims).
    const client = await connectMcpClient(
      baseUrl,
      await fixtures.mcpToken(userId, tenantId),
      'phase4-sync-point',
    );

    // 4. Search a real service via v11.
    const getResult = await client.callTool({
      name: 'ptv_get_service',
      arguments: { tenantId, environment: 'test', id: KNOWN_SERVICE_ID },
    });
    expect(getResult.isError).not.toBe(true);
    const currentService = toolJson<{ id: string; names: Record<string, string> }>(getResult);
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
    const proposal = toolJson<{
      proposed: unknown;
      diff: unknown[];
      correlationId: string;
    }>(proposeResult);
    expect(proposal.diff.length).toBeGreaterThan(0);
    const { correlationId } = proposal;

    // 6. Validate it, in the same audit chain.
    const validateResult = await client.callTool({
      name: 'ptv_validate_changes',
      arguments: { tenantId, environment: 'test', proposed: proposal.proposed, correlationId },
    });
    expect(validateResult.isError).not.toBe(true);
    const validation = toolJson<{ valid: boolean }>(validateResult);
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
    const exported = toolJson<{ languages: Record<string, { name?: string }> }>(exportResult);
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

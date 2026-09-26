import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import type { MembershipRole } from '../auth/rbac.js';
import { UserPtvConnectionService } from '../credentials/userPtvConnectionService.js';
import { AuditService } from '../audit/auditService.js';
import { inMemoryV11Factory, validService } from '../ptv/testing/fixtures.js';
import { IntegrationFixtures, listenLocally } from '../testing/integrationFixtures.js';
import { connectMcpClient, toolJson, toolText } from '../testing/mcpClient.js';
import type { Service } from '../ptv/domain.js';

const BASE_SERVICE = validService({
  id: 'phase6-service-1',
  organizationId: 'phase6-org-1',
  names: { fi: 'Phase 6 service', en: 'Phase 6 service' },
  summaries: { fi: 'Phase 6 summary' },
  descriptions: { fi: 'Phase 6 description' },
  languages: ['fi', 'en'],
  modifiedAt: '2026-09-16T00:00:00Z',
});

describe('Phase 6 sync point', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const connectionService = new UserPtvConnectionService(db, config.masterEncryptionKey);
  const auditService = new AuditService(db);
  const fixtures = new IntegrationFixtures(db, config);

  let app: FastifyInstance;
  let baseUrl: string;
  let capturedUserTokens: string[] = [];

  beforeAll(async () => {
    const inMemoryV11 = inMemoryV11Factory(() => ({ services: [{ ...BASE_SERVICE }] }));
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: (options) => {
          if (options.credential.scope === 'user' && options.credential.accessToken) {
            capturedUserTokens.push(options.credential.accessToken);
          }
          return inMemoryV11(options);
        },
      },
    });
    baseUrl = await listenLocally(app);
  });

  beforeEach(() => {
    capturedUserTokens = [];
  });

  afterEach(() => fixtures.cleanup());

  afterAll(async () => {
    await app.close();
  });

  const registerUser = async (name: string) =>
    (await fixtures.registeredUser(authService, 'phase6', name)).userId;

  /** Registers a user with `role` in `tenantId` and mints their MCP token for it. */
  async function member(tenantId: string, role: MembershipRole, name: string) {
    const userId = await registerUser(name);
    await fixtures.addMembership(tenantId, userId, role);
    return { userId, token: await fixtures.mcpToken(userId, tenantId) };
  }

  // These flows exercise the direct export/apply tools per role, which
  // four-eyes (on by default) refuses outright — see the last test.
  const createTenant = (name: string, requireFourEyes = false) =>
    fixtures.tenant({ name, slugPrefix: 'phase6', requireFourEyes, v11: { supportsWrite: true } });

  const storeV11Connection = (userId: string, token: string) =>
    connectionService.storeConnection(
      userId,
      'v11',
      'test',
      token,
      new Date('2030-01-01T00:00:00.000Z'),
    );

  const connectedClient = (token: string) => connectMcpClient(baseUrl, token, 'phase6-sync-point');

  it('runs propose/validate/export/apply flows with role-specific authorization behavior', async () => {
    const tenantId = await createTenant('Phase 6 role flow tenant');
    const [reader, editor, publisher, tenantAdmin] = await Promise.all([
      member(tenantId, 'contributor', 'Reader'),
      member(tenantId, 'approver', 'Editor'),
      member(tenantId, 'publisher', 'Publisher'),
      member(tenantId, 'tenant_admin', 'Tenant Admin'),
    ]);
    await storeV11Connection(publisher.userId, 'publisher-token');
    await storeV11Connection(tenantAdmin.userId, 'tenant-admin-token');

    const readerClient = await connectedClient(reader.token);
    const readerSearch = await readerClient.callTool({
      name: 'ptv_search_services',
      arguments: { tenantId, environment: 'test', query: 'service', pageSize: 1 },
    });
    expect(readerSearch.isError).not.toBe(true);
    const readerPropose = await readerClient.callTool({
      name: 'ptv_propose_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Reader queued change' } },
      },
    });
    expect(readerPropose.isError).not.toBe(true);
    const readerProposal = toolJson<{ proposalId: string; status: string }>(readerPropose);
    expect(readerProposal.proposalId.length).toBeGreaterThan(0);
    expect(readerProposal.status).toBe('pending');
    await readerClient.close();

    const editorClient = await connectedClient(editor.token);
    const editorPropose = await editorClient.callTool({
      name: 'ptv_propose_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Editor proposal' } },
      },
    });
    expect(editorPropose.isError).not.toBe(true);
    const editorProposal = toolJson<{
      proposed: Service;
      correlationId: string;
    }>(editorPropose);

    const editorValidate = await editorClient.callTool({
      name: 'ptv_validate_changes',
      arguments: {
        tenantId,
        environment: 'test',
        proposed: editorProposal.proposed,
        correlationId: editorProposal.correlationId,
      },
    });
    expect(editorValidate.isError).not.toBe(true);
    const validation = toolJson<{ valid: boolean }>(editorValidate);
    expect(validation.valid).toBe(true);

    const editorExport = await editorClient.callTool({
      name: 'ptv_export_for_manual_publish',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Editor export' } },
        correlationId: editorProposal.correlationId,
      },
    });
    expect(editorExport.isError).not.toBe(true);
    const exported = toolJson<{ correlationId: string }>(editorExport);
    expect(exported.correlationId).toBe(editorProposal.correlationId);

    const editorApply = await editorClient.callTool({
      name: 'ptv_apply_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Editor apply should fail' } },
      },
    });
    expect(editorApply.isError).toBe(true);
    expect(toolText(editorApply)).toContain('not_authorized');
    await editorClient.close();

    const editorAuditTrail = await auditService.listByCorrelationId(
      tenantId,
      editorProposal.correlationId,
    );
    expect(editorAuditTrail.map((entry) => entry.action)).toEqual([
      'ProposeServiceChange',
      'ValidateServiceChange',
      'ProposeServiceChange',
      'ExportForManualPublish',
    ]);

    const publisherClient = await connectedClient(publisher.token);
    const publisherApply = await publisherClient.callTool({
      name: 'ptv_apply_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Publisher apply' } },
      },
    });
    expect(publisherApply.isError).not.toBe(true);
    const publisherApplied = toolJson<{ serviceId: string }>(publisherApply);
    expect(publisherApplied.serviceId).toBe(BASE_SERVICE.id);
    await publisherClient.close();

    const tenantAdminClient = await connectedClient(tenantAdmin.token);
    const tenantAdminApply = await tenantAdminClient.callTool({
      name: 'ptv_apply_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Tenant admin apply' } },
      },
    });
    expect(tenantAdminApply.isError).not.toBe(true);
    const tenantAdminApplied = toolJson<{ serviceId: string }>(tenantAdminApply);
    expect(tenantAdminApplied.serviceId).toBe(BASE_SERVICE.id);
    await tenantAdminClient.close();
  });

  it('enforces tenant isolation and reuses one user-scoped connection across multiple allowed tenants', async () => {
    const [sharedPublisher, outsider] = await Promise.all([
      registerUser('Shared Publisher'),
      registerUser('Outsider'),
    ]);
    const [tenantA, tenantB, tenantC] = await Promise.all([
      createTenant('Tenant A'),
      createTenant('Tenant B'),
      createTenant('Tenant C'),
    ]);

    await Promise.all([
      fixtures.addMembership(tenantA, sharedPublisher, 'publisher'),
      fixtures.addMembership(tenantB, sharedPublisher, 'publisher'),
      fixtures.addMembership(tenantC, outsider, 'publisher'),
    ]);
    await storeV11Connection(sharedPublisher, 'shared-token');

    // One MCP token binds to exactly one tenant (see
    // IntegrationFixtures.mcpToken), so exercising the same user against
    // tenants A, B, and C means minting a token per tenant — the underlying v11
    // connection ('shared-token', keyed by userId, not tenantId) is what's
    // actually reused across all three, which is what this test's final
    // assertion confirms.
    const clientA = await connectedClient(await fixtures.mcpToken(sharedPublisher, tenantA));
    const applyInTenantA = await clientA.callTool({
      name: 'ptv_apply_changes',
      arguments: { serviceId: BASE_SERVICE.id, changes: { names: { fi: 'Tenant A apply' } } },
    });
    expect(applyInTenantA.isError).not.toBe(true);
    await clientA.close();

    const clientB = await connectedClient(await fixtures.mcpToken(sharedPublisher, tenantB));
    const applyInTenantB = await clientB.callTool({
      name: 'ptv_apply_changes',
      arguments: { serviceId: BASE_SERVICE.id, changes: { names: { fi: 'Tenant B apply' } } },
    });
    expect(applyInTenantB.isError).not.toBe(true);
    await clientB.close();

    // sharedPublisher has no membership in tenantC at all — a token bound
    // to it (however it was obtained) must still be rejected by the
    // registry's own membership check, not merely by the OAuth consent
    // screen not offering tenantC as a choice.
    const clientC = await connectedClient(await fixtures.mcpToken(sharedPublisher, tenantC));
    const forbiddenWrite = await clientC.callTool({
      name: 'ptv_apply_changes',
      arguments: { serviceId: BASE_SERVICE.id, changes: { names: { fi: 'Tenant C should fail' } } },
    });
    expect(forbiddenWrite.isError).toBe(true);
    // A total non-member has no role at all, so `ptv_apply_changes` fails the
    // Editor-level business check inside `proposeChanges()` (mcp/authorization.ts's
    // `NotAuthorizedError`) before ever reaching the registry's write-capable-adapter
    // resolution — a *member* whose role is too low is what produces the registry's
    // own `reason: 'not_authorized'` (see the Editor-can't-apply case above).
    expect(toolText(forbiddenWrite)).toContain("requires at least 'approver' role");

    const forbiddenRead = await clientC.callTool({
      name: 'ptv_search_services',
      arguments: { pageSize: 1 },
    });
    expect(forbiddenRead.isError).toBe(true);
    expect(toolText(forbiddenRead)).toContain('not_authorized');
    await clientC.close();

    const capturedSharedTokens = capturedUserTokens.filter((token) => token === 'shared-token');
    expect(capturedSharedTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses the direct export/apply tools when the tenant requires four-eyes', async () => {
    const tenantId = await createTenant('Phase 6 four-eyes tenant', true);
    const publisher = await member(tenantId, 'publisher', 'Four-eyes Publisher');
    await storeV11Connection(publisher.userId, 'four-eyes-token');
    const client = await connectedClient(publisher.token);

    for (const name of ['ptv_export_for_manual_publish', 'ptv_apply_changes']) {
      const result = await client.callTool({
        name,
        arguments: { serviceId: BASE_SERVICE.id, changes: { names: { fi: 'Suoraan' } } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('four-eyes');
    }
    await client.close();
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import type { MembershipRole } from '../auth/rbac.js';
import { AuditService } from '../audit/auditService.js';
import { inMemoryV11Factory, validService } from '../ptv/testing/fixtures.js';
import { IntegrationFixtures, listenLocally } from '../testing/integrationFixtures.js';
import { connectMcpClient, toolJson, toolText } from '../testing/mcpClient.js';

const BASE_SERVICE = validService({
  id: 'phase8-service-1',
  organizationId: 'phase8-org-1',
  names: { fi: 'Phase 8 service' },
  modifiedAt: '2026-09-16T00:00:00Z',
});

describe('Phase 8 sync point', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const auditService = new AuditService(db);
  const fixtures = new IntegrationFixtures(db, config);

  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: inMemoryV11Factory(() => ({ services: [{ ...BASE_SERVICE }] })),
      },
    });
    baseUrl = await listenLocally(app);
  });

  afterEach(() => fixtures.cleanup());

  afterAll(async () => {
    await app.close();
  });

  const createTenant = (name: string) =>
    fixtures.tenant({ name, slugPrefix: 'phase8', v11: { supportsWrite: true } });

  /** Registers a user with `role` in `tenantId` and mints their MCP token for it. */
  async function member(tenantId: string, role: MembershipRole, name: string) {
    const { userId } = await fixtures.registeredUser(authService, 'phase8', name);
    await fixtures.addMembership(tenantId, userId, role);
    return { userId, token: await fixtures.mcpToken(userId, tenantId) };
  }

  const connectedClient = (token: string) => connectMcpClient(baseUrl, token, 'phase8-sync-point');

  it('queues, reviews, and resolves proposals with the contributor/approver split and one correlationId', async () => {
    const tenantId = await createTenant('Phase 8 queue tenant');
    const [reader, editor] = await Promise.all([
      member(tenantId, 'contributor', 'Reader'),
      member(tenantId, 'approver', 'Editor'),
    ]);

    const readerClient = await connectedClient(reader.token);
    const queued = await readerClient.callTool({
      name: 'ptv_propose_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Reader queued proposal' } },
      },
    });
    expect(queued.isError).not.toBe(true);
    const queuedPayload = toolJson<{ proposalId: string; correlationId: string }>(queued);

    // A contributor (Ehdottaja) can view the queue but not resolve.
    const readerList = await readerClient.callTool({
      name: 'ptv_list_proposals',
      arguments: { tenantId, environment: 'test', status: 'pending' },
    });
    expect(readerList.isError).not.toBe(true);
    const readerResolve = await readerClient.callTool({
      name: 'ptv_resolve_proposal',
      arguments: { proposalId: queuedPayload.proposalId, action: 'reject' },
    });
    expect(readerResolve.isError).toBe(true);
    expect(toolText(readerResolve)).toContain("requires at least 'approver' role");
    await readerClient.close();

    const editorClient = await connectedClient(editor.token);
    const listPending = await editorClient.callTool({
      name: 'ptv_list_proposals',
      arguments: { tenantId, environment: 'test', status: 'pending' },
    });
    expect(listPending.isError).not.toBe(true);
    const pendingPayload = toolJson<Array<{ id: string }>>(listPending);
    expect(pendingPayload.some((proposal) => proposal.id === queuedPayload.proposalId)).toBe(true);

    const proposal = await editorClient.callTool({
      name: 'ptv_get_proposal',
      arguments: {
        tenantId,
        environment: 'test',
        proposalId: queuedPayload.proposalId,
      },
    });
    expect(proposal.isError).not.toBe(true);
    const proposalPayload = toolJson<{ diff: Array<{ field: string }> }>(proposal);
    expect(proposalPayload.diff.length).toBeGreaterThan(0);

    const resolved = await editorClient.callTool({
      name: 'ptv_resolve_proposal',
      arguments: {
        tenantId,
        environment: 'test',
        proposalId: queuedPayload.proposalId,
        action: 'reject',
      },
    });
    expect(resolved.isError).not.toBe(true);
    const resolvedPayload = toolJson<{ status: string }>(resolved);
    expect(resolvedPayload.status).toBe('rejected');

    const listAfter = await editorClient.callTool({
      name: 'ptv_list_proposals',
      arguments: { tenantId, environment: 'test', status: 'pending' },
    });
    const afterPayload = toolJson<Array<{ id: string }>>(listAfter);
    expect(afterPayload.some((proposalRow) => proposalRow.id === queuedPayload.proposalId)).toBe(
      false,
    );
    await editorClient.close();

    const auditTrail = await auditService.listByCorrelationId(
      tenantId,
      queuedPayload.correlationId,
    );
    expect(auditTrail.map((entry) => entry.action)).toEqual([
      'ProposeServiceChange',
      'ReviewProposal',
      'ResolveProposal',
    ]);
  });

  it('returns not_authorized for approve_and_apply from editor-only resolver and keeps proposal pending', async () => {
    const tenantId = await createTenant('Phase 8 apply gate tenant');
    const [reader, editor] = await Promise.all([
      member(tenantId, 'contributor', 'Reader'),
      member(tenantId, 'approver', 'Editor'),
    ]);

    const readerClient = await connectedClient(reader.token);
    const queued = await readerClient.callTool({
      name: 'ptv_propose_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Needs publisher approval for apply' } },
      },
    });
    const queuedPayload = toolJson<{ proposalId: string }>(queued);
    await readerClient.close();

    const editorClient = await connectedClient(editor.token);
    const applyAttempt = await editorClient.callTool({
      name: 'ptv_resolve_proposal',
      arguments: {
        tenantId,
        environment: 'test',
        proposalId: queuedPayload.proposalId,
        action: 'approve_and_apply',
      },
    });
    expect(applyAttempt.isError).toBe(true);
    expect(toolText(applyAttempt)).toContain('not_authorized');

    const pending = await editorClient.callTool({
      name: 'ptv_get_proposal',
      arguments: { tenantId, environment: 'test', proposalId: queuedPayload.proposalId },
    });
    const proposal = toolJson<{ status: string }>(pending);
    expect(proposal.status).toBe('pending');
    await editorClient.close();
  });
});

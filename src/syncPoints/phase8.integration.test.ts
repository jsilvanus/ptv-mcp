import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, proposals, tenants, users } from '../db/schema/index.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { AuditService } from '../audit/auditService.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import type { Service } from '../ptv/domain.js';

const BASE_SERVICE: Service = {
  id: 'phase8-service-1',
  organizationId: 'phase8-org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Phase 8 service' },
  summaries: {},
  descriptions: {},
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: [],
  modifiedAt: '2026-09-16T00:00:00Z',
};

describe('Phase 8 sync point', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const configService = new PtvAdapterConfigService(db);
  const auditService = new AuditService(db);

  let app: FastifyInstance;
  let baseUrl: string;
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: (options) =>
          new InMemoryPtvAdapter({
            services: [{ ...BASE_SERVICE }],
            capabilities: {
              apiVersion: 'v11',
              environment: options.environment,
              credentialScope: 'user',
              supportsRead: true,
              supportsWrite: options.canWrite,
              supportsDraftRead: false,
            },
          }),
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a network address for the listening server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const tenantId of createdTenantIds) {
      await withContext(db, { tenantId }, async (tx) => {
        await tx.delete(auditEntries).where(eq(auditEntries.tenantId, tenantId));
        await tx.delete(proposals).where(eq(proposals.tenantId, tenantId));
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

  afterAll(async () => {
    await app.close();
  });

  async function registerUser(name: string): Promise<{ userId: string; token: string }> {
    const email = `phase8-${randomUUID()}@example.test`;
    const { userId } = await authService.register(email, name, 'correct-password');
    createdUserIds.push(userId);
    const session = await authService.login(email, 'correct-password');
    return { userId, token: session.accessToken };
  }

  async function createTenant(name: string): Promise<string> {
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name, slug: `phase8-${tenantId}` });
    createdTenantIds.push(tenantId);
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    return tenantId;
  }

  async function addMembership(
    tenantId: string,
    userId: string,
    role: 'reader' | 'editor' | 'publisher' | 'tenant_admin',
  ): Promise<void> {
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values({ tenantId, userId, role });
    });
  }

  async function connectedClient(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    });
    const client = new Client({ name: 'phase8-sync-point', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);
    return client;
  }

  function parseToolResult<T>(result: unknown): T {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const first = content[0];
    if (!first || first.type !== 'text' || typeof first.text !== 'string') {
      throw new Error('Expected text tool content');
    }
    return JSON.parse(first.text) as T;
  }

  it('queues, reviews, and resolves proposals with reader/editor split and one correlationId', async () => {
    const tenantId = await createTenant('Phase 8 queue tenant');
    const [reader, editor] = await Promise.all([registerUser('Reader'), registerUser('Editor')]);
    await Promise.all([
      addMembership(tenantId, reader.userId, 'reader'),
      addMembership(tenantId, editor.userId, 'editor'),
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
    const queuedPayload = parseToolResult<{ proposalId: string; correlationId: string }>(queued);

    const readerList = await readerClient.callTool({
      name: 'ptv_list_proposals',
      arguments: { tenantId, environment: 'test', status: 'pending' },
    });
    expect(readerList.isError).toBe(true);
    expect((readerList.content as Array<{ text: string }>)[0]?.text).toContain(
      "requires at least 'editor' role",
    );
    await readerClient.close();

    const editorClient = await connectedClient(editor.token);
    const listPending = await editorClient.callTool({
      name: 'ptv_list_proposals',
      arguments: { tenantId, environment: 'test', status: 'pending' },
    });
    expect(listPending.isError).not.toBe(true);
    const pendingPayload = parseToolResult<Array<{ id: string }>>(listPending);
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
    const proposalPayload = parseToolResult<{ diff: Array<{ field: string }> }>(proposal);
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
    const resolvedPayload = parseToolResult<{ status: string }>(resolved);
    expect(resolvedPayload.status).toBe('rejected');

    const listAfter = await editorClient.callTool({
      name: 'ptv_list_proposals',
      arguments: { tenantId, environment: 'test', status: 'pending' },
    });
    const afterPayload = parseToolResult<Array<{ id: string }>>(listAfter);
    expect(afterPayload.some((proposalRow) => proposalRow.id === queuedPayload.proposalId)).toBe(false);
    await editorClient.close();

    const auditTrail = await auditService.listByCorrelationId(tenantId, queuedPayload.correlationId);
    expect(auditTrail.map((entry) => entry.action)).toEqual([
      'ProposeServiceChange',
      'ReviewProposal',
      'ResolveProposal',
    ]);
  });

  it('returns not_authorized for approve_and_apply from editor-only resolver and keeps proposal pending', async () => {
    const tenantId = await createTenant('Phase 8 apply gate tenant');
    const [reader, editor] = await Promise.all([registerUser('Reader'), registerUser('Editor')]);
    await Promise.all([
      addMembership(tenantId, reader.userId, 'reader'),
      addMembership(tenantId, editor.userId, 'editor'),
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
    const queuedPayload = parseToolResult<{ proposalId: string }>(queued);
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
    expect((applyAttempt.content as Array<{ text: string }>)[0]?.text).toContain('not_authorized');

    const pending = await editorClient.callTool({
      name: 'ptv_get_proposal',
      arguments: { tenantId, environment: 'test', proposalId: queuedPayload.proposalId },
    });
    const proposal = parseToolResult<{ status: string }>(pending);
    expect(proposal.status).toBe('pending');
    await editorClient.close();
  });
});

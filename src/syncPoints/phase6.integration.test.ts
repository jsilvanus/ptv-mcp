import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, tenants, users } from '../db/schema/index.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { UserPtvConnectionService } from '../credentials/userPtvConnectionService.js';
import { AuditService } from '../audit/auditService.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import type { Service } from '../ptv/domain.js';

const BASE_SERVICE: Service = {
  id: 'phase6-service-1',
  organizationId: 'phase6-org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Phase 6 service', en: 'Phase 6 service' },
  summaries: { fi: 'Phase 6 summary' },
  descriptions: { fi: 'Phase 6 description' },
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi', 'en'],
  serviceChannelIds: [],
  modifiedAt: '2026-09-16T00:00:00Z',
};

describe('Phase 6 sync point', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const adapterConfigService = new PtvAdapterConfigService(db);
  const connectionService = new UserPtvConnectionService(db, config.masterEncryptionKey);
  const auditService = new AuditService(db);

  let app: FastifyInstance;
  let baseUrl: string;
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];
  let capturedUserTokens: string[] = [];

  beforeAll(async () => {
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: (options) => {
          if (options.credential.scope === 'user' && options.credential.accessToken) {
            capturedUserTokens.push(options.credential.accessToken);
          }
          return new InMemoryPtvAdapter({
            services: [{ ...BASE_SERVICE }],
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
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a network address for the listening server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    capturedUserTokens = [];
  });

  afterEach(async () => {
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
    createdTenantIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerUser(name: string): Promise<{ userId: string; token: string }> {
    const email = `phase6-${randomUUID()}@example.test`;
    const { userId } = await authService.register(email, name, 'correct-password');
    createdUserIds.push(userId);
    const session = await authService.login(email, 'correct-password');
    return { userId, token: session.accessToken };
  }

  async function createTenant(name: string): Promise<string> {
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name, slug: `phase6-${tenantId}` });
    createdTenantIds.push(tenantId);
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

  async function configureV11(tenantId: string, supportsWrite: boolean): Promise<void> {
    await adapterConfigService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite,
      supportsDraftRead: false,
    });
  }

  async function connectedClient(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { Authorization: `****** } },
    });
    const client = new Client({ name: 'phase6-sync-point', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);
    return client;
  }

  function parseToolResult<T>(result: CallToolResult): T {
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]!.text) as T;
  }

  it('runs propose/validate/export/apply flows with role-specific authorization behavior', async () => {
    const tenantId = await createTenant('Phase 6 role flow tenant');
    const [reader, editor, publisher, tenantAdmin] = await Promise.all([
      registerUser('Reader'),
      registerUser('Editor'),
      registerUser('Publisher'),
      registerUser('Tenant Admin'),
    ]);
    await Promise.all([
      addMembership(tenantId, reader.userId, 'reader'),
      addMembership(tenantId, editor.userId, 'editor'),
      addMembership(tenantId, publisher.userId, 'publisher'),
      addMembership(tenantId, tenantAdmin.userId, 'tenant_admin'),
    ]);
    await configureV11(tenantId, true);
    await connectionService.storeConnection(
      publisher.userId,
      'v11',
      'test',
      'publisher-token',
      new Date('2030-01-01T00:00:00.000Z'),
    );
    await connectionService.storeConnection(
      tenantAdmin.userId,
      'v11',
      'test',
      'tenant-admin-token',
      new Date('2030-01-01T00:00:00.000Z'),
    );

    const readerClient = await connectedClient(reader.token);
    const readerSearch = await readerClient.callTool({
      name: 'ptv_search_services',
      arguments: { tenantId, environment: 'test', pageSize: 1 },
    });
    expect(readerSearch.isError).not.toBe(true);
    const readerPropose = await readerClient.callTool({
      name: 'ptv_propose_changes',
      arguments: {
        tenantId,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Reader blocked change' } },
      },
    });
    expect(readerPropose.isError).toBe(true);
    expect((readerPropose.content as Array<{ text: string }>)[0]?.text).toContain(
      "requires at least 'editor' role",
    );
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
    const editorProposal = parseToolResult<{
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
    const validation = parseToolResult<{ valid: boolean }>(editorValidate);
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
    const exported = parseToolResult<{ correlationId: string }>(editorExport);
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
    expect((editorApply.content as Array<{ text: string }>)[0]?.text).toContain('not_authorized');
    await editorClient.close();

    const editorAuditTrail = await auditService.listByCorrelationId(tenantId, editorProposal.correlationId);
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
    const publisherApplied = parseToolResult<{ serviceId: string }>(publisherApply);
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
    const tenantAdminApplied = parseToolResult<{ serviceId: string }>(tenantAdminApply);
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
      addMembership(tenantA, sharedPublisher.userId, 'publisher'),
      addMembership(tenantB, sharedPublisher.userId, 'publisher'),
      addMembership(tenantC, outsider.userId, 'publisher'),
    ]);
    await Promise.all([configureV11(tenantA, true), configureV11(tenantB, true), configureV11(tenantC, true)]);
    await connectionService.storeConnection(
      sharedPublisher.userId,
      'v11',
      'test',
      'shared-token',
      new Date('2030-01-01T00:00:00.000Z'),
    );

    const sharedClient = await connectedClient(sharedPublisher.token);
    const applyInTenantA = await sharedClient.callTool({
      name: 'ptv_apply_changes',
      arguments: {
        tenantId: tenantA,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Tenant A apply' } },
      },
    });
    expect(applyInTenantA.isError).not.toBe(true);

    const applyInTenantB = await sharedClient.callTool({
      name: 'ptv_apply_changes',
      arguments: {
        tenantId: tenantB,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Tenant B apply' } },
      },
    });
    expect(applyInTenantB.isError).not.toBe(true);

    const forbiddenWrite = await sharedClient.callTool({
      name: 'ptv_apply_changes',
      arguments: {
        tenantId: tenantC,
        environment: 'test',
        serviceId: BASE_SERVICE.id,
        changes: { names: { fi: 'Tenant C should fail' } },
      },
    });
    expect(forbiddenWrite.isError).toBe(true);
    expect((forbiddenWrite.content as Array<{ text: string }>)[0]?.text).toContain('not_authorized');

    const forbiddenRead = await sharedClient.callTool({
      name: 'ptv_search_services',
      arguments: { tenantId: tenantC, environment: 'test', pageSize: 1 },
    });
    expect(forbiddenRead.isError).toBe(true);
    expect((forbiddenRead.content as Array<{ text: string }>)[0]?.text).toContain('not_authorized');
    await sharedClient.close();

    const capturedSharedTokens = capturedUserTokens.filter((token) => token === 'shared-token');
    expect(capturedSharedTokens.length).toBeGreaterThanOrEqual(2);
  });
});

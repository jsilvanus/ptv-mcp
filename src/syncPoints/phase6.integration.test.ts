import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
import { OAuthService } from '../mcp/oauthService.js';
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
  serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
  ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
  targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
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
  // Must match src/app.ts's OAuthService construction (same issuer/resource)
  // — mints real MCP OAuth access tokens the way httpTransport.ts verifies
  // them, unlike AuthService's web-session JWT (no iss/aud/tenant claims).
  const oauthService = new OAuthService(
    db,
    config.jwtSecret,
    config.mcpPublicUrl,
    config.mcpPublicUrl,
  );

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

  async function registerUser(name: string): Promise<{ userId: string }> {
    const email = `phase6-${randomUUID()}@example.test`;
    const { userId } = await authService.register(email, name, 'correct-password');
    createdUserIds.push(userId);
    await authService.login(email, 'correct-password');
    return { userId };
  }

  /**
   * MCP tools have no per-call tenant/environment argument — see
   * toolContext() in mcpServer.ts — so exercising a user against a
   * particular tenant means minting a token bound to that tenant, not
   * passing one in `arguments`.
   */
  async function mintToken(userId: string, tenantId: string): Promise<string> {
    return oauthService.issueAccessToken(
      userId,
      'urn:ptv-mcp:test-client',
      'mcp',
      tenantId,
      'test',
      'v11',
      'v11',
    );
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
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    });
    const client = new Client({ name: 'phase6-sync-point', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);
    return client;
  }

  function parseToolResult<T>(result: unknown): T {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const [first] = content;
    if (!first || first.type !== 'text' || typeof first.text !== 'string') {
      throw new Error('Expected text tool content');
    }
    return JSON.parse(first.text) as T;
  }

  it('runs propose/validate/export/apply flows with role-specific authorization behavior', async () => {
    const tenantId = await createTenant('Phase 6 role flow tenant');
    const [readerUser, editorUser, publisherUser, tenantAdminUser] = await Promise.all([
      registerUser('Reader'),
      registerUser('Editor'),
      registerUser('Publisher'),
      registerUser('Tenant Admin'),
    ]);
    await Promise.all([
      addMembership(tenantId, readerUser.userId, 'reader'),
      addMembership(tenantId, editorUser.userId, 'editor'),
      addMembership(tenantId, publisherUser.userId, 'publisher'),
      addMembership(tenantId, tenantAdminUser.userId, 'tenant_admin'),
    ]);
    const [reader, editor, publisher, tenantAdmin] = await Promise.all([
      mintToken(readerUser.userId, tenantId).then((token) => ({ ...readerUser, token })),
      mintToken(editorUser.userId, tenantId).then((token) => ({ ...editorUser, token })),
      mintToken(publisherUser.userId, tenantId).then((token) => ({ ...publisherUser, token })),
      mintToken(tenantAdminUser.userId, tenantId).then((token) => ({ ...tenantAdminUser, token })),
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
    const readerProposal = parseToolResult<{ proposalId: string; status: string }>(readerPropose);
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
    await Promise.all([
      configureV11(tenantA, true),
      configureV11(tenantB, true),
      configureV11(tenantC, true),
    ]);
    await connectionService.storeConnection(
      sharedPublisher.userId,
      'v11',
      'test',
      'shared-token',
      new Date('2030-01-01T00:00:00.000Z'),
    );

    // One MCP token binds to exactly one tenant (see mintToken's doc
    // comment above), so exercising the same user against tenants A, B,
    // and C means minting a token per tenant — the underlying v11
    // connection ('shared-token', keyed by userId, not tenantId) is what's
    // actually reused across all three, which is what this test's final
    // assertion confirms.
    const clientA = await connectedClient(await mintToken(sharedPublisher.userId, tenantA));
    const applyInTenantA = await clientA.callTool({
      name: 'ptv_apply_changes',
      arguments: { serviceId: BASE_SERVICE.id, changes: { names: { fi: 'Tenant A apply' } } },
    });
    expect(applyInTenantA.isError).not.toBe(true);
    await clientA.close();

    const clientB = await connectedClient(await mintToken(sharedPublisher.userId, tenantB));
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
    const clientC = await connectedClient(await mintToken(sharedPublisher.userId, tenantC));
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
    expect((forbiddenWrite.content as Array<{ text: string }>)[0]?.text).toContain(
      "requires at least 'editor' role",
    );

    const forbiddenRead = await clientC.callTool({
      name: 'ptv_search_services',
      arguments: { pageSize: 1 },
    });
    expect(forbiddenRead.isError).toBe(true);
    expect((forbiddenRead.content as Array<{ text: string }>)[0]?.text).toContain('not_authorized');
    await clientC.close();

    const capturedSharedTokens = capturedUserTokens.filter((token) => token === 'shared-token');
    expect(capturedSharedTokens.length).toBeGreaterThanOrEqual(2);
  });
});

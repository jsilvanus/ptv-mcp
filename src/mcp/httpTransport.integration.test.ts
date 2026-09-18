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
import { memberships, tenants, users } from '../db/schema/index.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';

/**
 * Proves the real MCP protocol wire-up — a genuine `@modelcontextprotocol/sdk`
 * `Client` over `StreamableHTTPClientTransport`, talking to this app's
 * `/mcp` route over a real HTTP socket — not calling the tool functions
 * directly (those are covered exhaustively by unit tests already; this
 * file is specifically about the transport/auth/registration wiring).
 */
describe('MCP HTTP transport', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    mailer: new LoggingMailer(() => {}),
  });
  const configService = new PtvAdapterConfigService(db);

  let app: FastifyInstance;
  let baseUrl: string;
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a network address for the listening server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    for (const tenantId of createdTenantIds) {
      await withContext(db, { tenantId }, async (tx) => {
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

  async function registeredUserWithTenant(): Promise<{ token: string; tenantId: string }> {
    const email = `mcp-${randomUUID()}@example.test`;
    const { userId } = await authService.register(email, 'MCP Test User', 'correct-password');
    createdUserIds.push(userId);
    const session = await authService.login(email, 'correct-password');

    const tenantId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: 'MCP Test Tenant', slug: `mcp-${tenantId}` });
    createdTenantIds.push(tenantId);
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values({ tenantId, userId, role: 'reader' });
    });

    return { token: session.accessToken, tenantId };
  }

  async function connectedClient(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    // See src/mcp/httpTransport.ts's identical cast note: the SDK's own
    // optional-property declarations don't satisfy exactOptionalPropertyTypes
    // here, though the class does implement Transport structurally.
    await client.connect(transport as unknown as Transport);
    return client;
  }

  it('lists every registered tool', async () => {
    const { token } = await registeredUserWithTenant();
    const client = await connectedClient(token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'ptv_search_services',
        'ptv_get_service',
        'ptv_search_channels',
        'ptv_get_channel',
        'ptv_get_organisation',
        'ptv_get_organisation_hierarchy',
        'ptv_search_service_collections',
        'ptv_search_general_descriptions',
        'ptv_search_connections',
        'ptv_list_codes',
        'ptv_propose_changes',
        'ptv_list_proposals',
        'ptv_get_proposal',
        'ptv_resolve_proposal',
        'ptv_validate_changes',
        'ptv_export_for_manual_publish',
        'ptv_apply_changes',
      ]),
    );
    await client.close();
  });

  it('rejects a request with no bearer token at the HTTP layer, before any MCP handshake', async () => {
    const res = await fetch(new URL('/mcp', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('calls ptv_search_services against PTV live test environment and gets real results back', async () => {
    const { token, tenantId } = await registeredUserWithTenant();
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const client = await connectedClient(token);
    const result = await client.callTool({
      name: 'ptv_search_services',
      arguments: { tenantId, environment: 'test', query: 'service', pageSize: 1 },
    });

    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { items: unknown[] };
    expect(Array.isArray(payload.items)).toBe(true);
    await client.close();
  });

  it('surfaces a not_authorized tool error for a tenant the user does not belong to', async () => {
    const { token } = await registeredUserWithTenant();
    const otherTenantId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: otherTenantId, name: 'Someone Else', slug: `other-${otherTenantId}` });
    createdTenantIds.push(otherTenantId);
    await configService.upsert(otherTenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const client = await connectedClient(token);
    const result = await client.callTool({
      name: 'ptv_search_services',
      arguments: { tenantId: otherTenantId, environment: 'test' },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain('not_authorized');
    await client.close();
  });

  it('lists get-by-id resource templates and reads one service resource', async () => {
    const { token, tenantId } = await registeredUserWithTenant();
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const client = await connectedClient(token);
    const templates = await client.listResourceTemplates();
    const templateUris = templates.resourceTemplates.map((template) => template.uriTemplate);
    expect(templateUris).toEqual(
      expect.arrayContaining([
        'ptv://{tenantId}/{environment}/services/{serviceId}',
        'ptv://{tenantId}/{environment}/channels/{channelId}',
        'ptv://{tenantId}/{environment}/organisations/{organisationId}',
        'ptv://{tenantId}/{environment}/organisations/{organisationId}/hierarchy',
        'ptv://{tenantId}/{environment}/code-lists/{codeListName}',
      ]),
    );

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    expect(resourceUris).toEqual(
      expect.arrayContaining([
        'ptv://{tenantId}/{environment}/services/{serviceId}',
        'ptv://{tenantId}/{environment}/channels/{channelId}',
        'ptv://{tenantId}/{environment}/organisations/{organisationId}',
        'ptv://{tenantId}/{environment}/organisations/{organisationId}/hierarchy',
        'ptv://{tenantId}/{environment}/code-lists/{codeListName}',
      ]),
    );

    const read = await client.readResource({
      uri: `ptv://${tenantId}/test/services/af60add0-c3be-40f6-9c22-3e29c2b8da0a`,
    });
    const first = read.contents[0];
    expect(first?.mimeType).toBe('application/json');
    expect(first?.uri).toBe(`ptv://${tenantId}/test/services/af60add0-c3be-40f6-9c22-3e29c2b8da0a`);
    await client.close();
  });

  it('surfaces an unauthorized resource read as a protocol-level error', async () => {
    const { token } = await registeredUserWithTenant();
    const otherTenantId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: otherTenantId, name: 'Someone Else', slug: `other-${otherTenantId}` });
    createdTenantIds.push(otherTenantId);
    await configService.upsert(otherTenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    // Resource handlers (unlike tools) don't catch PtvAdapterResolutionError,
    // so it propagates out of the SDK's ReadResourceRequestSchema handler and
    // becomes a JSON-RPC-level error, not a structured CallToolResult-style
    // error the way the equivalent tool call surfaces it (see the
    // 'surfaces a not_authorized tool error' test above for the contrast).
    // Confirmed live: the client receives an `McpError` with the generic
    // JSON-RPC "Internal error" code (-32603) — there is no equivalent to the
    // tool-error path's machine-readable `not_authorized` reason string here,
    // only PtvAdapterResolutionError's human-readable message text.
    const client = await connectedClient(token);
    await expect(
      client.readResource({
        uri: `ptv://${otherTenantId}/test/services/11111111-2222-3333-4444-555555555555`,
      }),
    ).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining('is not authorized'),
    });
    await client.close();
  });

  it('returns null content for a not-found resource read', async () => {
    const { token, tenantId } = await registeredUserWithTenant();
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });

    const client = await connectedClient(token);
    const read = await client.readResource({
      uri: `ptv://${tenantId}/test/services/11111111-2222-3333-4444-555555555555`,
    });

    const first = read.contents[0] as { mimeType?: string; text?: string } | undefined;
    expect(first?.mimeType).toBe('application/json');
    expect(first?.text).toBe('null');
    await client.close();
  });
});

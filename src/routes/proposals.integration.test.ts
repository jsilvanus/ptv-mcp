import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, proposals, tenants, users } from '../db/schema/index.js';
import { signAccessToken } from '../auth/jwt.js';
import type { MembershipRole } from '../auth/rbac.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import { OAuthService } from '../mcp/oauthService.js';
import type { Service } from '../ptv/domain.js';

const BASE_SERVICE: Service = {
  id: 'route-proposal-service',
  organizationId: 'route-org',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Route service' },
  summaries: {},
  descriptions: {},
  serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
  ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
  targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: [],
  modifiedAt: '2026-09-16T00:00:00Z',
};

describe('proposal routes', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const configService = new PtvAdapterConfigService(db);
  // Must match src/app.ts's OAuthService construction (same issuer/resource)
  // — mints real MCP OAuth access tokens the way httpTransport.ts verifies
  // them, unlike signAccessToken's web-session JWT (no iss/aud/tenant
  // claims), which is what /tenants/:id/proposals's own auth expects.
  const oauthService = new OAuthService(
    db,
    config.jwtSecret,
    config.mcpPublicUrl,
    config.mcpPublicUrl,
  );
  let app: FastifyInstance;
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
  });

  afterAll(async () => {
    await app.close();
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

  async function createUser(role?: MembershipRole) {
    const userId = randomUUID();
    const tenantId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: 'Proposal route user',
      passwordHash: 'x',
    });
    createdUserIds.push(userId);
    const token = await signAccessToken({ sub: userId }, config.jwtSecret);

    await db.insert(tenants).values({
      id: tenantId,
      name: 'Proposal route tenant',
      slug: `pr-${tenantId}`,
    });
    createdTenantIds.push(tenantId);
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    if (role) {
      await withContext(db, { tenantId }, async (tx) => {
        await tx.insert(memberships).values({ tenantId, userId, role });
      });
    }

    return { userId, tenantId, token };
  }

  it('lets a contributor propose and view but not resolve, an approver resolve, and blocks a viewer', async () => {
    const editor = await createUser('approver');
    const readerId = randomUUID();
    await db.insert(users).values({
      id: readerId,
      email: `${readerId}@example.test`,
      name: 'Reader',
      passwordHash: 'x',
    });
    createdUserIds.push(readerId);
    const readerToken = await signAccessToken({ sub: readerId }, config.jwtSecret);
    await withContext(db, { tenantId: editor.tenantId }, async (tx) => {
      await tx.insert(memberships).values({
        tenantId: editor.tenantId,
        userId: readerId,
        role: 'contributor',
      });
    });
    // The /mcp call below needs a real MCP OAuth token (tenant/environment/
    // api-version claims), not the plain web-session JWT `readerToken` is
    // — that one is still correct for the REST /tenants/:id/proposals
    // check further down, which goes through a different auth path.
    const readerMcpToken = await oauthService.issueAccessToken(
      readerId,
      'urn:ptv-mcp:test-client',
      'mcp',
      editor.tenantId,
      'test',
      'v11',
      'v11',
    );

    const queuedByReader = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: 'Bearer ' + readerMcpToken,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ptv_propose_changes',
          arguments: {
            tenantId: editor.tenantId,
            environment: 'test',
            serviceId: BASE_SERVICE.id,
            changes: { names: { fi: 'Route queued' } },
          },
        },
      },
    });
    expect(queuedByReader.statusCode).toBe(200);

    // Contributors (Ehdottaja) can view the queue but not resolve.
    const listAsReader = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals`,
      headers: { authorization: 'Bearer ' + readerToken },
    });
    expect(listAsReader.statusCode).toBe(200);

    // Viewers (Katselija) are read-only: no proposal queue.
    const viewerId = randomUUID();
    await db.insert(users).values({
      id: viewerId,
      email: `${viewerId}@example.test`,
      name: 'Viewer',
      passwordHash: 'x',
    });
    createdUserIds.push(viewerId);
    await withContext(db, { tenantId: editor.tenantId }, async (tx) => {
      await tx
        .insert(memberships)
        .values({ tenantId: editor.tenantId, userId: viewerId, role: 'viewer' });
    });
    const listAsViewer = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals`,
      headers: {
        authorization: 'Bearer ' + (await signAccessToken({ sub: viewerId }, config.jwtSecret)),
      },
    });
    expect(listAsViewer.statusCode).toBe(403);

    const listAsEditor = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals?status=pending`,
      headers: { authorization: 'Bearer ' + editor.token },
    });
    expect(listAsEditor.statusCode).toBe(200);
    const [first] = listAsEditor.json() as Array<{ id: string }>;
    expect(first?.id).toBeTruthy();

    const getAsEditor = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}`,
      headers: { authorization: 'Bearer ' + editor.token },
    });
    expect(getAsEditor.statusCode).toBe(200);

    const commentAsContributor = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/comments`,
      headers: { authorization: 'Bearer ' + readerToken },
      payload: { comment: 'Tarkistin tekstin.' },
    });
    expect(commentAsContributor.statusCode).toBe(201);
    const withComment = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}`,
      headers: { authorization: 'Bearer ' + editor.token },
    });
    expect(
      (withComment.json() as { comments: Array<{ body: string; userName: string }> }).comments,
    ).toEqual([expect.objectContaining({ body: 'Tarkistin tekstin.', userName: 'Reader' })]);
    const emptyComment = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/comments`,
      headers: { authorization: 'Bearer ' + readerToken },
      payload: { comment: '  ' },
    });
    expect(emptyComment.statusCode).toBe(400);

    const resolveAsContributor = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/resolve`,
      headers: { authorization: 'Bearer ' + readerToken },
      payload: { action: 'reject' },
    });
    expect(resolveAsContributor.statusCode).toBe(403);

    // Required reviewer: the approver asks the viewer (refused, below
    // Contributor), then the contributor; approving waits for the sign-off.
    const candidates = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/review-candidates`,
      headers: { authorization: 'Bearer ' + editor.token },
    });
    expect((candidates.json() as Array<{ userId: string }>).map((c) => c.userId).sort()).toEqual(
      [editor.userId, readerId].sort(),
    );
    const viewerAsReviewer = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/reviewers`,
      headers: { authorization: 'Bearer ' + editor.token },
      payload: { reviewers: [`${viewerId}@example.test`] },
    });
    expect(viewerAsReviewer.statusCode).toBe(400);
    // The contributor proposed this one, so they cannot review it; the
    // approver names themself instead and the contributor gets a 403 on sign-off.
    const addReviewer = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/reviewers`,
      headers: { authorization: 'Bearer ' + editor.token },
      payload: { reviewers: [`${editor.userId}@example.test`] },
    });
    expect(addReviewer.statusCode).toBe(201);
    const waiting = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals?waitingForMe=true`,
      headers: { authorization: 'Bearer ' + editor.token },
    });
    expect((waiting.json() as Array<{ id: string }>).map((p) => p.id)).toEqual([first!.id]);
    const exportBeforeSignOff = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/resolve`,
      headers: { authorization: 'Bearer ' + editor.token },
      payload: { action: 'approve_and_export' },
    });
    expect(exportBeforeSignOff.statusCode).toBe(409);
    const signOffAsNonReviewer = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/sign-off`,
      headers: { authorization: 'Bearer ' + readerToken },
      payload: { decision: 'approved' },
    });
    expect(signOffAsNonReviewer.statusCode).toBe(403);
    const signOff = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/sign-off`,
      headers: { authorization: 'Bearer ' + editor.token },
      payload: { decision: 'changes_requested', comment: 'Lisää aukioloajat.' },
    });
    expect(signOff.statusCode).toBe(200);
    const withReviewers = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}`,
      headers: { authorization: 'Bearer ' + editor.token },
    });
    expect((withReviewers.json() as { reviewers: unknown[] }).reviewers).toEqual([
      expect.objectContaining({
        userId: editor.userId,
        decision: 'changes_requested',
        comment: 'Lisää aukioloajat.',
      }),
    ]);

    const resolveAsEditor = await app.inject({
      method: 'POST',
      url: `/tenants/${editor.tenantId}/proposals/${first!.id}/resolve`,
      headers: { authorization: 'Bearer ' + editor.token },
      payload: { action: 'reject' },
    });
    expect(resolveAsEditor.statusCode).toBe(200);
    expect((resolveAsEditor.json() as { status: string }).status).toBe('rejected');
  });
});

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries } from '../db/schema/index.js';
import type { MembershipRole } from '../auth/rbac.js';
import { inMemoryV11Factory, validService } from '../ptv/testing/fixtures.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';
import { injectToolCall } from '../testing/mcpClient.js';

const BASE_SERVICE = validService({
  id: 'route-proposal-service',
  organizationId: 'route-org',
  names: { fi: 'Route service' },
  modifiedAt: '2026-09-16T00:00:00Z',
});

describe('proposal routes', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  // `fixtures.mcpToken` is the MCP OAuth token /mcp verifies;
  // `fixtures.webToken` the web-session JWT the /tenants/:id/proposals
  // REST routes expect. They are not interchangeable.
  const fixtures = new IntegrationFixtures(db, config);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: inMemoryV11Factory(() => ({ services: [{ ...BASE_SERVICE }] })),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => fixtures.cleanup());

  /** A user in a fresh tenant with v11 configured; a member with `role` if given. */
  async function createUser(role?: MembershipRole, options: { requireFourEyes?: boolean } = {}) {
    const userId = await fixtures.user('Proposal route user');
    const token = await fixtures.webToken(userId);
    const tenantId = await fixtures.tenant({
      name: 'Proposal route tenant',
      slugPrefix: 'pr',
      v11: { supportsWrite: true },
      ...options,
    });
    if (role) await fixtures.addMembership(tenantId, userId, role);
    return { userId, tenantId, token };
  }

  it('lets a contributor propose and view but not resolve, an approver resolve, and blocks a viewer', async () => {
    const editor = await createUser('approver');
    const readerId = await fixtures.user('Reader');
    const readerToken = await fixtures.webToken(readerId);
    await fixtures.addMembership(editor.tenantId, readerId, 'contributor');
    // The /mcp call below needs a real MCP OAuth token (tenant/environment/
    // api-version claims), not the plain web-session JWT `readerToken` is
    // — that one is still correct for the REST /tenants/:id/proposals
    // check further down, which goes through a different auth path.
    const readerMcpToken = await fixtures.mcpToken(readerId, editor.tenantId);

    const queuedByReader = await injectToolCall(app, readerMcpToken, 'ptv_propose_changes', {
      tenantId: editor.tenantId,
      environment: 'test',
      serviceId: BASE_SERVICE.id,
      changes: { names: { fi: 'Route queued' } },
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
    const viewerId = await fixtures.user('Viewer');
    await fixtures.addMembership(editor.tenantId, viewerId, 'viewer');
    const listAsViewer = await app.inject({
      method: 'GET',
      url: `/tenants/${editor.tenantId}/proposals`,
      headers: {
        authorization: 'Bearer ' + (await fixtures.webToken(viewerId)),
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

  it('exports an approved proposal with a manual-publishing sheet and confirms it against PTV', async () => {
    const publisher = await createUser('publisher', { requireFourEyes: false });
    const mcpToken = await fixtures.mcpToken(publisher.userId, publisher.tenantId);
    const propose = async (names: Record<string, string>) => {
      const response = await injectToolCall(app, mcpToken, 'ptv_propose_changes', {
        serviceId: BASE_SERVICE.id,
        changes: { names },
      });
      expect(response.statusCode).toBe(200);
      const list = await app.inject({
        method: 'GET',
        url: `/tenants/${publisher.tenantId}/proposals?status=pending`,
        headers: { authorization: 'Bearer ' + publisher.token },
      });
      return (list.json() as Array<{ id: string }>)[0]!.id;
    };
    const resolve = (id: string, action: string) =>
      app.inject({
        method: 'POST',
        url: `/tenants/${publisher.tenantId}/proposals/${id}/resolve`,
        headers: { authorization: 'Bearer ' + publisher.token },
        payload: { action },
      });
    const confirm = (id: string) =>
      app.inject({
        method: 'POST',
        url: `/tenants/${publisher.tenantId}/proposals/${id}/confirm-published`,
        headers: { authorization: 'Bearer ' + publisher.token },
        payload: {},
      });

    // Not yet entered in PTV: the sheet lists the name, confirming is refused.
    const renamed = await propose({ fi: 'Route renamed' });
    expect((await confirm(renamed)).statusCode).toBe(409);
    const exported = await resolve(renamed, 'approve_and_export');
    expect(exported.statusCode).toBe(200);
    const details = exported.json() as {
      status: string;
      publishedInPtv: boolean | null;
      manualPublish: { action: string; ptvId: string; fields: unknown[]; steps: string[] };
    };
    expect(details.status).toBe('approved');
    expect(details.publishedInPtv).toBe(false);
    expect(details.manualPublish).toMatchObject({ action: 'update', ptvId: BASE_SERVICE.id });
    expect(details.manualPublish.fields).toEqual([
      {
        field: 'names',
        label: 'Nimi',
        language: 'fi',
        before: 'Route service',
        after: 'Route renamed',
      },
    ]);
    const notYet = await confirm(renamed);
    expect(notYet.statusCode).toBe(409);
    expect(notYet.body).toContain('names.fi');

    // Already in PTV (the in-memory PTV has this name): confirming closes it.
    const same = await propose({ fi: BASE_SERVICE.names.fi! });
    const sameExported = (await resolve(same, 'approve_and_export')).json() as {
      publishedInPtv: boolean;
      manualPublish: { fields: unknown[] };
    };
    expect(sameExported.publishedInPtv).toBe(true);
    expect(sameExported.manualPublish.fields).toEqual([]);
    const confirmed = await confirm(same);
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { status: string }).status).toBe('applied');
    const audit = await withContext(db, { tenantId: publisher.tenantId }, (tx) =>
      tx.select().from(auditEntries).where(eq(auditEntries.tenantId, publisher.tenantId)),
    );
    expect(audit.map((entry) => entry.action)).toContain('ConfirmManualPublish');
    expect((await confirm(same)).statusCode).toBe(409);
  });
});

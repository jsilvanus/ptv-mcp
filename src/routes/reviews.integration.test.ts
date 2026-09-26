import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries } from '../db/schema/index.js';
import type { MembershipRole } from '../auth/rbac.js';
import { TenantEnvironmentService } from '../credentials/tenantEnvironmentService.js';
import { inMemoryV11Factory } from '../ptv/testing/fixtures.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';
import { injectToolCall, type InjectedToolResult } from '../testing/mcpClient.js';
import type { Organization, Service, ServiceChannel } from '../ptv/domain.js';

const ROOT_ORG = 'b0a1c2d3-0000-4000-8000-000000000001';
const SUB_ORG = 'b0a1c2d3-0000-4000-8000-000000000002';
const OTHER_ORG = 'b0a1c2d3-0000-4000-8000-000000000003';

const ORGANISATIONS: Organization[] = [
  { id: ROOT_ORG, publishingStatus: 'Published', names: { fi: 'Testiseurakuntayhtymä' } },
  {
    id: SUB_ORG,
    parentOrganizationId: ROOT_ORG,
    publishingStatus: 'Published',
    names: { fi: 'Testiseurakunta' },
  },
  { id: OTHER_ORG, publishingStatus: 'Published', names: { fi: 'Muu organisaatio' } },
];

function service(id: string, overrides: Partial<Service> = {}): Service {
  return {
    id,
    organizationId: SUB_ORG,
    serviceType: 'Service',
    publishingStatus: 'Published',
    names: { fi: `Palvelu ${id}` },
    summaries: { fi: 'Lyhyt kuvaus palvelusta asiakkaalle.' },
    descriptions: { fi: 'Palvelussa saat apua. Varaa aika verkossa.' },
    serviceClasses: [{ code: 'P27.1', names: {} }],
    ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p1', names: {} }],
    targetGroups: [{ code: 'KR1', names: {} }],
    lifeEvents: [],
    industrialClasses: [],
    languages: ['fi'],
    serviceChannelIds: [],
    ...overrides,
  };
}

const GOOD_SERVICE = service('review-good', { serviceChannelIds: ['review-channel-1'] });
const BAD_SERVICE = service('review-bad', {
  descriptions: { fi: 'Soita numeroon 040 123 4567, niin kerromme lisää.' },
});

function channel(id: string): ServiceChannel {
  return {
    id,
    organizationId: SUB_ORG,
    channelType: 'Phone',
    publishingStatus: 'Published',
    names: { fi: `Kanava ${id}` },
    descriptions: { fi: 'Puhelinpalvelussa saat neuvontaa.' },
    languages: ['fi'],
  };
}

describe('review campaign routes and tools', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const tenantEnvironmentService = new TenantEnvironmentService(db, config.masterEncryptionKey);
  const fixtures = new IntegrationFixtures(db, config);
  const configService = fixtures.adapterConfigs;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: inMemoryV11Factory(() => ({
          organizations: ORGANISATIONS,
          // The fake ignores organizationId filters, so each organisation
          // "has" every service; the campaign de-duplicates them.
          services: [{ ...GOOD_SERVICE }, { ...BAD_SERVICE }],
          channels: [channel('review-channel-1'), channel('review-channel-2')],
          connections: [{ serviceId: GOOD_SERVICE.id, channelId: 'review-channel-1' }],
        })),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => fixtures.cleanup());

  const createTenant = () =>
    fixtures.tenant({ name: 'Review tenant', slugPrefix: 'rv', v11: { supportsWrite: true } });

  /** A user with `role` in `tenantId`, with both a web-UI and an MCP token. */
  async function createMember(tenantId: string, role: MembershipRole, name: string) {
    const userId = await fixtures.user(name);
    await fixtures.addMembership(tenantId, userId, role);
    return {
      userId,
      email: `${userId}@example.test`,
      token: await fixtures.webToken(userId),
      mcpToken: await fixtures.mcpToken(userId, tenantId),
    };
  }

  async function callTool(
    mcpToken: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: InjectedToolResult; data: unknown }> {
    const { statusCode, result, data } = await injectToolCall(app, mcpToken, name, args);
    expect(statusCode).toBe(200);
    return { result, data };
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('runs a full review: start, assign, propose, complete, reopen and close', async () => {
    const tenantId = await createTenant();
    const publisher = await createMember(tenantId, 'publisher', 'Julkaisija');
    const reviewer = await createMember(tenantId, 'contributor', 'Tarkistaja');
    const other = await createMember(tenantId, 'contributor', 'Toinen');
    const viewer = await createMember(tenantId, 'viewer', 'Katselija');

    // Only Publisher+ starts a campaign.
    const denied = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns`,
      headers: auth(reviewer.token),
      payload: { name: 'Syystarkistus', organizationId: ROOT_ORG, environment: 'test' },
    });
    expect(denied.statusCode).toBe(403);

    const started = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns`,
      headers: auth(publisher.token),
      payload: {
        name: 'Syystarkistus',
        organizationId: ROOT_ORG,
        environment: 'test',
        dueDate: '2026-12-31',
      },
    });
    expect(started.statusCode).toBe(201);
    const campaign = started.json() as {
      id: string;
      correlationId: string;
      progress: { total: number };
    };
    // Root + sub-organisation, two services, two channels; the other organisation is left out.
    expect(campaign.progress.total).toBe(6);

    const again = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns`,
      headers: auth(publisher.token),
      payload: { name: 'Toinen', organizationId: ROOT_ORG, environment: 'test' },
    });
    expect(again.statusCode).toBe(400);

    const detail = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/review-campaigns/${campaign.id}`,
      headers: auth(publisher.token),
    });
    type Item = {
      id: string;
      targetKind: string;
      targetId: string;
      status: string;
      assigneeUserId: string | null;
      findings: { checkId: string; severity: string }[];
      proposals: { id: string; status: string }[];
    };
    const items = (detail.json() as { items: Item[] }).items;
    expect(items.map((item) => item.targetId).sort()).toEqual(
      [
        ROOT_ORG,
        SUB_ORG,
        GOOD_SERVICE.id,
        BAD_SERVICE.id,
        'review-channel-1',
        'review-channel-2',
      ].sort(),
    );
    const bad = items.find((item) => item.targetId === BAD_SERVICE.id)!;
    expect(bad.findings.map((f) => f.checkId)).toEqual(
      expect.arrayContaining(['Q-STRUCT-1', 'Q-STRUCT-5']),
    );
    const good = items.find((item) => item.targetId === GOOD_SERVICE.id)!;
    expect(good.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const unconnected = items.find((item) => item.targetId === 'review-channel-2')!;
    expect(unconnected.findings.map((f) => f.checkId)).toContain('Q-STRUCT-5');

    // Viewers can't see campaigns; contributors can.
    const asViewer = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/review-campaigns`,
      headers: auth(viewer.token),
    });
    expect(asViewer.statusCode).toBe(403);

    // Assign every service and channel to the reviewer; a viewer can't be a reviewer.
    const viewerAssign = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns/${campaign.id}/assign`,
      headers: auth(publisher.token),
      payload: { reviewer: viewer.email, targetKind: 'service' },
    });
    expect(viewerAssign.statusCode).toBe(400);
    const contributorAssign = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns/${campaign.id}/assign`,
      headers: auth(reviewer.token),
      payload: { reviewer: reviewer.email, targetKind: 'service' },
    });
    expect(contributorAssign.statusCode).toBe(403);
    for (const targetKind of ['service', 'channel']) {
      const assigned = await app.inject({
        method: 'POST',
        url: `/tenants/${tenantId}/review-campaigns/${campaign.id}/assign`,
        headers: auth(publisher.token),
        payload: { reviewer: reviewer.email, targetKind },
      });
      expect(assigned.statusCode).toBe(200);
      expect((assigned.json() as { assigned: number }).assigned).toBe(2);
    }

    // The reviewer sees their items through MCP.
    const mine = await callTool(reviewer.mcpToken, 'ptv_review_my_items', {});
    expect((mine.data as Item[]).map((item) => item.targetId).sort()).toEqual(
      [GOOD_SERVICE.id, BAD_SERVICE.id, 'review-channel-1', 'review-channel-2'].sort(),
    );
    const item = await callTool(reviewer.mcpToken, 'ptv_review_get_item', { itemId: bad.id });
    expect((item.data as { quality: { errors: number } }).quality.errors).toBeGreaterThan(0);

    // A proposal must target the item's own service.
    const wrongTarget = await callTool(reviewer.mcpToken, 'ptv_propose_changes', {
      serviceId: GOOD_SERVICE.id,
      changes: { descriptions: { fi: 'Uusi kuvaus.' } },
      reviewItemId: bad.id,
    });
    expect(wrongTarget.result.isError).toBe(true);
    // Only the assignee (or a Publisher+) may link to the item.
    const notAssignee = await callTool(other.mcpToken, 'ptv_propose_changes', {
      serviceId: BAD_SERVICE.id,
      changes: { descriptions: { fi: 'Uusi kuvaus.' } },
      reviewItemId: bad.id,
    });
    expect(notAssignee.result.isError).toBe(true);

    // Confirming without proposals is fine; sending on needs a linked proposal.
    const noProposals = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${bad.id}/complete`,
      headers: auth(reviewer.token),
      payload: { decision: 'changes_proposed' },
    });
    expect(noProposals.statusCode).toBe(400);

    const proposed = await callTool(reviewer.mcpToken, 'ptv_propose_changes', {
      serviceId: BAD_SERVICE.id,
      changes: { descriptions: { fi: 'Kysy lisää puhelinpalvelusta.' } },
      reviewItemId: bad.id,
    });
    expect(proposed.result.isError).toBeFalsy();
    const proposal = proposed.data as {
      proposalId: string;
      quality: { findings: { checkId: string }[] };
    };
    expect(proposal.quality.findings.map((f) => f.checkId)).not.toContain('Q-STRUCT-1');

    const confirmWithPending = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${bad.id}/complete`,
      headers: auth(reviewer.token),
      payload: { decision: 'confirmed' },
    });
    expect(confirmWithPending.statusCode).toBe(400);

    const byOther = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${bad.id}/complete`,
      headers: auth(other.token),
      payload: { decision: 'changes_proposed' },
    });
    expect(byOther.statusCode).toBe(403);

    const sent = await callTool(reviewer.mcpToken, 'ptv_review_complete_item', {
      itemId: bad.id,
      decision: 'changes_proposed',
      note: 'Puhelinnumero kuvauksessa, poistettu.',
    });
    expect(sent.result.isError).toBeFalsy();
    expect(sent.data).toMatchObject({
      status: 'changes_proposed',
      proposals: [{ id: proposal.proposalId, status: 'pending' }],
    });

    // The Publisher's inbox lists the change as ready to resolve; the reviewer's lists it as nothing to resolve.
    const publisherTasks = await callTool(publisher.mcpToken, 'ptv_my_tasks', {});
    expect(publisherTasks.data).toMatchObject({
      changesToHandle: [
        { id: proposal.proposalId, readiness: 'ready_to_resolve', reviewItemId: bad.id },
      ],
      openCampaigns: [{ id: campaign.id }],
    });
    const reviewerTasks = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/my-tasks?environment=test`,
      headers: auth(reviewer.token),
    });
    expect(reviewerTasks.json()).toMatchObject({ changesToHandle: [], openCampaigns: [] });
    expect((reviewerTasks.json() as { reviewItems: unknown[] }).reviewItems).toHaveLength(3);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${good.id}/complete`,
      headers: auth(reviewer.token),
      payload: { decision: 'confirmed' },
    });
    expect(confirmed.statusCode).toBe(200);

    // The proposal carries its review item in the normal queue.
    const queued = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/proposals/${proposal.proposalId}`,
      headers: auth(publisher.token),
    });
    expect(queued.json()).toMatchObject({ reviewItemId: bad.id });

    // A Publisher sends an item back; the reviewer can't.
    const reopenByReviewer = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${good.id}/reopen`,
      headers: auth(reviewer.token),
      payload: {},
    });
    expect(reopenByReviewer.statusCode).toBe(403);
    const reopened = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${good.id}/reopen`,
      headers: auth(publisher.token),
      payload: { note: 'Tarkista vielä aukioloajat.' },
    });
    expect(reopened.json()).toMatchObject({ status: 'open', note: 'Tarkista vielä aukioloajat.' });

    const list = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/review-campaigns`,
      headers: auth(reviewer.token),
    });
    expect((list.json() as { progress: unknown }[])[0]?.progress).toEqual({
      total: 6,
      open: 5,
      confirmed: 0,
      changesProposed: 1,
      unassigned: 2,
    });

    const closed = await callTool(publisher.mcpToken, 'ptv_review_close_campaign', {
      campaignId: campaign.id,
    });
    expect(closed.data).toMatchObject({ status: 'closed' });
    const afterClose = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${good.id}/complete`,
      headers: auth(reviewer.token),
      payload: { decision: 'confirmed' },
    });
    expect(afterClose.statusCode).toBe(400);

    const audit = await withContext(db, { tenantId }, async (tx) =>
      tx
        .select({ action: auditEntries.action })
        .from(auditEntries)
        .where(eq(auditEntries.correlationId, campaign.correlationId)),
    );
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'StartReviewCampaign',
        'AssignReviewItems',
        'CompleteReviewItem',
        'ReopenReviewItem',
        'CloseReviewCampaign',
      ]),
    );
  });

  it("sends a Publisher's draft channel to the item's reviewer, then creates it", async () => {
    const tenantId = await createTenant();
    // Writes go through the tenant's API user (tenant-scoped credentials).
    await tenantEnvironmentService.storeCredentials(tenantId, 'test', 'v11', {
      username: 'api-user',
      password: 'secret',
    });
    await configService.upsert(tenantId, 'test', 'v11', {
      authMode: 'api_login',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: false,
    });
    const publisher = await createMember(tenantId, 'publisher', 'Julkaisija');
    const secondPublisher = await createMember(tenantId, 'publisher', 'Toinen julkaisija');
    const reviewer = await createMember(tenantId, 'contributor', 'Tarkistaja');

    const started = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns`,
      headers: auth(publisher.token),
      payload: { name: 'Kanavat', organizationId: ROOT_ORG, environment: 'test' },
    });
    const campaign = started.json() as { id: string };
    const detail = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/review-campaigns/${campaign.id}`,
      headers: auth(publisher.token),
    });
    const items = (detail.json() as { items: { id: string; targetId: string }[] }).items;
    const orgItem = items.find((item) => item.targetId === SUB_ORG)!;
    const serviceItem = items.find((item) => item.targetId === GOOD_SERVICE.id)!;
    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-campaigns/${campaign.id}/assign`,
      headers: auth(publisher.token),
      payload: { reviewer: reviewer.email, itemIds: [orgItem.id, serviceItem.id] },
    });
    // The reviewer confirms the service; a Publisher's draft reopens it below.
    await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${serviceItem.id}/complete`,
      headers: auth(reviewer.token),
      payload: { decision: 'confirmed' },
    });

    // An invalid channel is still queued, with its validation and checks.
    const invalid = await callTool(publisher.mcpToken, 'ptv_propose_new_channel', {
      channel: {
        channelType: 'Phone',
        organizationId: SUB_ORG,
        names: { fi: 'Diakoniatyön puhelin' },
        descriptions: { fi: 'Soita diakoniatyöntekijälle.' },
        languages: ['fi'],
        phoneNumbers: [{ language: 'fi', number: '040 123 4567' }],
      },
    });
    expect(invalid.data).toMatchObject({ validation: { valid: false } });
    const unsupported = await callTool(publisher.mcpToken, 'ptv_propose_new_channel', {
      channel: { channelType: 'Phone', organizationId: SUB_ORG, addresses: [] },
    });
    expect(unsupported.result.isError).toBe(true);
    // A field another channel type has is refused on this type.
    const wrongType = await callTool(publisher.mcpToken, 'ptv_propose_channel_changes', {
      channelId: 'review-channel-1',
      changes: { addresses: [] },
    });
    expect(wrongType.result.content[0]?.text).toContain('on a Phone channel');

    const drafted = await callTool(publisher.mcpToken, 'ptv_propose_new_channel', {
      channel: {
        channelType: 'Phone',
        organizationId: SUB_ORG,
        names: { fi: 'Diakoniatyön puhelin' },
        summaries: { fi: 'Soita, kun tarvitset keskusteluapua tai taloudellista neuvontaa.' },
        descriptions: { fi: 'Diakoniatyöntekijä vastaa arkisin. Voit myös jättää soittopyynnön.' },
        languages: ['fi'],
        phoneNumbers: [
          {
            language: 'fi',
            prefixNumber: '+358',
            number: '40 123 4567',
            additionalInformation: 'Diakonia',
          },
        ],
        serviceHours: [
          {
            type: 'DaysOfTheWeek',
            openingTimes: [{ dayFrom: 'Monday', dayTo: 'Friday', from: '09:00', to: '12:00' }],
          },
        ],
        serviceIds: [GOOD_SERVICE.id],
      },
      reviewItemId: orgItem.id,
    });
    expect(drafted.result.isError).toBeFalsy();
    const draft = drafted.data as {
      proposalId: string;
      validation: { valid: boolean };
      quality: { errors: number };
    };
    expect(draft.validation.valid).toBe(true);
    expect(draft.quality.errors).toBe(0);

    // A draft service change attached afterwards reopens the confirmed item.
    const serviceDraft = await callTool(publisher.mcpToken, 'ptv_propose_changes', {
      serviceId: GOOD_SERVICE.id,
      changes: { serviceChannelIds: ['review-channel-1', 'review-channel-2'] },
    });
    const serviceDraftId = (serviceDraft.data as { proposalId: string }).proposalId;
    const attached = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/review-items/${serviceItem.id}/attach`,
      headers: auth(publisher.token),
      payload: { proposalId: serviceDraftId },
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json()).toMatchObject({
      status: 'open',
      proposals: [{ id: serviceDraftId, status: 'pending' }],
    });

    // Both drafts wait for the reviewer's sign-off.
    const tasks = await callTool(reviewer.mcpToken, 'ptv_my_tasks', {});
    expect(
      (tasks.data as { proposalsAwaitingMySignOff: { id: string }[] }).proposalsAwaitingMySignOff
        .map((p) => p.id)
        .sort(),
    ).toEqual([draft.proposalId, serviceDraftId].sort());
    const tooEarly = await callTool(secondPublisher.mcpToken, 'ptv_resolve_proposal', {
      proposalId: draft.proposalId,
      action: 'approve_and_apply',
    });
    expect(tooEarly.result.isError).toBe(true);

    const signed = await callTool(reviewer.mcpToken, 'ptv_sign_off_proposal', {
      proposalId: draft.proposalId,
      decision: 'approved',
    });
    expect(signed.result.isError).toBeFalsy();
    const applied = await callTool(secondPublisher.mcpToken, 'ptv_resolve_proposal', {
      proposalId: draft.proposalId,
      action: 'approve_and_apply',
    });
    expect(applied.result.isError).toBeFalsy();
    const created = applied.data as { status: string; serviceId: string };
    expect(created.status).toBe('applied');
    expect(created.serviceId).not.toBe('');

    // The test adapter is rebuilt per call, so check what was written in the audit log.
    const writes = await withContext(db, { tenantId }, async (tx) =>
      tx
        .select({ result: auditEntries.result, afterState: auditEntries.afterState })
        .from(auditEntries)
        .where(eq(auditEntries.action, 'CreateChannel')),
    );
    expect(writes).toEqual([
      {
        result: 'Success',
        afterState: expect.objectContaining({
          channelType: 'Phone',
          serviceIds: [GOOD_SERVICE.id],
          phoneNumbers: [expect.objectContaining({ number: '40 123 4567' })],
        }),
      },
    ]);
  });

  it('checks a published service with ptv_check_quality', async () => {
    const tenantId = await createTenant();
    const member = await createMember(tenantId, 'viewer', 'Katselija');
    const checked = await callTool(member.mcpToken, 'ptv_check_quality', {
      kind: 'service',
      id: BAD_SERVICE.id,
    });
    expect(checked.result.isError).toBeFalsy();
    expect(checked.data).toMatchObject({ kind: 'service', id: BAD_SERVICE.id });
    expect(
      (checked.data as { report: { findings: { checkId: string }[] } }).report.findings.map(
        (f) => f.checkId,
      ),
    ).toEqual(expect.arrayContaining(['Q-STRUCT-1', 'Q-STRUCT-5']));
  });

  it("exports an organisation's content as an Excel file for a contributor, audited", async () => {
    const tenantId = await createTenant();
    const contributor = await createMember(tenantId, 'contributor', 'Ehdottaja');
    const viewer = await createMember(tenantId, 'viewer', 'Katselija');
    const url = `/tenants/${tenantId}/ptv/content-export?organizationId=${ROOT_ORG}&environment=test`;

    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${contributor.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain(`ptv-sisalto-${ROOT_ORG}-test-`);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(res.rawPayload.toString('latin1')).toContain('xl/worksheets/sheet6.xml');

    const forbidden = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/ptv/content-export`,
      headers: { authorization: `Bearer ${contributor.token}` },
    });
    expect(missing.statusCode).toBe(400);

    const audit = await withContext(db, { tenantId }, (tx) =>
      tx.select().from(auditEntries).where(eq(auditEntries.tenantId, tenantId)),
    );
    expect(audit.map((entry) => entry.action)).toContain('ExportContent');
  });
});

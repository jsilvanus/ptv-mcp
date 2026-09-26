import { describe, expect, it, vi } from 'vitest';
import { PtvAdapterResolutionError, type PtvAdapterRegistry } from '../ptv/registry.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import type { Organization, Service } from '../ptv/domain.js';
import { fakeAuditService } from './testing/fakeAuditService.js';
import {
  commentOnProposal,
  getProposal,
  listProposals,
  queueProposal,
  requestReview,
  resolveProposal,
  signOffProposal,
  type MemberLister,
  type ResolveProposalAction,
} from './proposalQueue.js';
import type { MembershipRoleResolver } from './authorization.js';
import {
  NotARequestedReviewerError,
  type ProposalRecord,
  type ProposalReviewer,
  type ProposalService,
  type ProposalStatus,
} from '../proposals/proposalService.js';
import { V11ChangeValidator } from '../validation/changeValidator.js';
import { queueNewServiceProposal } from './newServiceProposal.js';
import { queueChannelProposal } from './channelProposal.js';
import { queueConnectionProposal } from './connectionProposal.js';
import { queueNewOrganizationProposal, queueOrganizationProposal } from './organizationProposal.js';
import { confirmManualPublish } from './proposalQueue.js';

const ctx = { tenantId: 'tenant-1', environment: 'test' as const, actingUserId: 'user-1' };
/** approve_and_apply needs a selected write API before the registry's role check runs. */
const writeCtx = { ...ctx, writeApiVersion: 'v11' };
const readerResolver: MembershipRoleResolver = async () => 'contributor';
const editorResolver: MembershipRoleResolver = async () => 'approver';
const publisherResolver: MembershipRoleResolver = async () => 'publisher';
const noFourEyes = async () => false;
const fourEyes = async () => true;
const members: MemberLister = async () => [
  { userId: 'user-1', name: 'Proposer', email: 'proposer@example.test', role: 'contributor' },
  { userId: 'user-2', name: 'Kirkkoherra', email: 'Vicar@example.test', role: 'approver' },
  { userId: 'user-3', name: 'Viewer', email: 'viewer@example.test', role: 'viewer' },
];

const service: Service = {
  id: 'svc-1',
  organizationId: 'org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Vanha nimi' },
  summaries: {},
  descriptions: {},
  serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
  ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
  targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: [],
  modifiedAt: '2026-01-01T00:00:00Z',
};

function buildRegistry(supportsWrite = true): PtvAdapterRegistry {
  return {
    resolve: vi.fn(async (request) => {
      if (request.operation === 'write' && !supportsWrite) {
        throw new PtvAdapterResolutionError('not allowed', 'not_authorized');
      }
      return new InMemoryPtvAdapter({
        services: [{ ...service }],
        capabilities: {
          apiVersion: 'v11',
          environment: request.environment,
          credentialScope: 'user',
          supportsRead: true,
          supportsWrite,
          supportsDraftRead: false,
        },
      });
    }),
  };
}

function fakeProposalService() {
  const rows: ProposalRecord[] = [];
  const comments: Array<{
    id: string;
    proposalId: string;
    userId: string;
    userName: string;
    body: string;
    createdAt: Date;
  }> = [];
  const reviewers: Array<ProposalReviewer & { proposalId: string }> = [];
  const api = {
    createPending: vi.fn(async (input) => {
      const row: ProposalRecord = {
        id: `proposal-${rows.length + 1}`,
        tenantId: input.tenantId,
        kind: input.kind ?? 'service_update',
        serviceId: input.serviceId,
        environment: input.environment,
        proposedByUserId: input.proposedByUserId,
        status: 'pending',
        changes: input.changes,
        queuedDiff: input.queuedDiff,
        correlationId: input.correlationId,
        resolvedByUserId: null,
        resolvedAt: null,
        reviewItemId: input.reviewItemId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return row;
    }),
    listForTenant: vi.fn(async (_tenantId: string, options?: { status?: ProposalStatus }) =>
      rows.filter((row) => (options?.status ? row.status === options.status : true)),
    ),
    addComment: vi.fn(
      async (_tenantId: string, proposalId: string, userId: string, body: string) => {
        const comment = {
          id: `comment-${comments.length + 1}`,
          proposalId,
          userId,
          userName: `User ${userId}`,
          body,
          createdAt: new Date(),
        };
        comments.push(comment);
        return comment;
      },
    ),
    listComments: vi.fn(async (_tenantId: string, proposalId: string) =>
      comments.filter((comment) => comment.proposalId === proposalId),
    ),
    addReviewers: vi.fn(
      async (_tenantId: string, proposalId: string, userIds: string[], requestedBy: string) => {
        for (const userId of userIds) {
          if (!reviewers.some((r) => r.proposalId === proposalId && r.userId === userId)) {
            reviewers.push({
              proposalId,
              userId,
              userName: `User ${userId}`,
              requestedByUserId: requestedBy,
              decision: 'pending',
              comment: null,
              requestedAt: new Date(),
              decidedAt: null,
            });
          }
        }
        return reviewers.filter((r) => r.proposalId === proposalId);
      },
    ),
    listReviewers: vi.fn(async (_tenantId: string, proposalId: string) =>
      reviewers.filter((r) => r.proposalId === proposalId),
    ),
    recordDecision: vi.fn(
      async (
        _tenantId: string,
        proposalId: string,
        userId: string,
        decision: 'approved' | 'changes_requested',
        comment: string | null,
      ) => {
        const reviewer = reviewers.find((r) => r.proposalId === proposalId && r.userId === userId);
        if (!reviewer) throw new NotARequestedReviewerError(proposalId);
        Object.assign(reviewer, { decision, comment, decidedAt: new Date() });
        return reviewers.filter((r) => r.proposalId === proposalId);
      },
    ),
    listAwaitingReview: vi.fn(async (_tenantId: string, userId: string) =>
      rows.filter(
        (row) =>
          row.status === 'pending' &&
          reviewers.some(
            (r) => r.proposalId === row.id && r.userId === userId && r.decision === 'pending',
          ),
      ),
    ),
    markPublished: vi.fn(async (_tenantId: string, proposalId: string, serviceId?: string) => {
      const row = rows.find((entry) => entry.id === proposalId);
      if (!row) throw new Error('not found');
      row.status = 'applied';
      if (serviceId) row.serviceId = serviceId;
      return row;
    }),
    getById: vi.fn(async (_tenantId: string, proposalId: string) => {
      const row = rows.find((entry) => entry.id === proposalId);
      if (!row) {
        throw new Error('not found');
      }
      return row;
    }),
    markResolved: vi.fn(
      async (
        _tenantId: string,
        proposalId: string,
        status: Exclude<ProposalStatus, 'pending'>,
        _resolvedBy: string,
        serviceId?: string,
      ) => {
        const row = rows.find((entry) => entry.id === proposalId);
        if (!row) {
          throw new Error('not found');
        }
        row.status = status;
        if (serviceId) row.serviceId = serviceId;
        row.resolvedByUserId = ctx.actingUserId;
        row.resolvedAt = new Date();
        row.updatedAt = new Date();
        return row;
      },
    ),
  };
  return { rows, api: api as unknown as ProposalService };
}

describe('proposalQueue', () => {
  it('queues a reader proposal and lets editor list/get/reject it', async () => {
    const registry = buildRegistry();
    const audit = fakeAuditService();
    const { rows, api } = fakeProposalService();

    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Uusi nimi' },
    });
    expect(queued.status).toBe('pending');
    expect(rows).toHaveLength(1);

    const listed = await listProposals(editorResolver, api, ctx, 'pending');
    expect(listed).toHaveLength(1);

    const reviewed = await getProposal(
      editorResolver,
      registry,
      api,
      audit,
      ctx,
      queued.proposalId,
    );
    expect(reviewed.diff.length).toBeGreaterThan(0);

    const resolved = await resolveProposal(
      editorResolver,
      registry,
      api,
      audit,
      new V11ChangeValidator(),
      ctx,
      queued.proposalId,
      'reject' as ResolveProposalAction,
      noFourEyes,
    );
    expect(resolved.status).toBe('rejected');
  });

  it('keeps proposal pending when editor attempts approve_and_apply without write access', async () => {
    const registry = buildRegistry(false);
    const audit = fakeAuditService();
    const { rows, api } = fakeProposalService();
    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Apply me' },
    });

    await expect(
      resolveProposal(
        editorResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        writeCtx,
        queued.proposalId,
        'approve_and_apply',
        noFourEyes,
      ),
    ).rejects.toMatchObject({ reason: 'not_authorized' });

    expect(rows[0]?.status).toBe('pending');
  });

  it('refuses approving your own proposal under four-eyes, but lets you reject it', async () => {
    const registry = buildRegistry(true);
    const audit = fakeAuditService();
    const { rows, api } = fakeProposalService();
    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Oma ehdotus' },
    });

    for (const action of ['approve_and_apply', 'approve_and_export'] as const) {
      await expect(
        resolveProposal(
          publisherResolver,
          registry,
          api,
          audit,
          new V11ChangeValidator(),
          writeCtx,
          queued.proposalId,
          action,
          fourEyes,
        ),
      ).rejects.toThrow(/Four-eyes/);
    }
    expect(rows[0]?.status).toBe('pending');

    const otherUser = { ...writeCtx, actingUserId: 'user-2' };
    const exported = await resolveProposal(
      editorResolver,
      registry,
      api,
      audit,
      new V11ChangeValidator(),
      otherUser,
      queued.proposalId,
      'approve_and_export',
      fourEyes,
    );
    expect(exported.status).not.toBe('pending');

    const second = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Peruttava' },
    });
    const rejected = await resolveProposal(
      editorResolver,
      registry,
      api,
      audit,
      new V11ChangeValidator(),
      ctx,
      second.proposalId,
      'reject',
      fourEyes,
    );
    expect(rejected.status).toBe('rejected');
  });

  it('holds approval until every required reviewer approves, and lists it as waiting', async () => {
    const registry = buildRegistry(true);
    const audit = fakeAuditService();
    const { rows, api } = fakeProposalService();
    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Tarkistettava' },
    });

    // The proposer names the vicar by email (case-insensitive).
    const requested = await requestReview(
      readerResolver,
      members,
      api,
      audit,
      ctx,
      queued.proposalId,
      ['vicar@example.test'],
    );
    expect(requested).toEqual([expect.objectContaining({ userId: 'user-2', decision: 'pending' })]);
    await expect(
      requestReview(readerResolver, members, api, audit, ctx, queued.proposalId, [
        'viewer@example.test',
      ]),
    ).rejects.toThrow(/not a Contributor.*Kirkkoherra <Vicar@example.test>/);
    await expect(
      requestReview(readerResolver, members, api, audit, ctx, queued.proposalId, ['user-1']),
    ).rejects.toThrow(/proposer cannot review/);

    const vicarCtx = { ...writeCtx, actingUserId: 'user-2' };
    const waiting = await listProposals(editorResolver, api, vicarCtx, undefined, true);
    expect(waiting.map((p) => p.id)).toEqual([queued.proposalId]);

    const publisherCtx = { ...writeCtx, actingUserId: 'user-4' };
    const approve = () =>
      resolveProposal(
        publisherResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        publisherCtx,
        queued.proposalId,
        'approve_and_apply',
        fourEyes,
      );
    await expect(approve()).rejects.toThrow(/Waiting for required reviewers: User user-2/);

    await signOffProposal(
      editorResolver,
      api,
      audit,
      vicarCtx,
      queued.proposalId,
      'changes_requested',
      'Lisää aukioloajat',
    );
    await expect(approve()).rejects.toThrow(/changes_requested/);
    expect(await listProposals(editorResolver, api, vicarCtx, undefined, true)).toEqual([]);

    await signOffProposal(editorResolver, api, audit, vicarCtx, queued.proposalId, 'approved');
    const applied = await approve();
    expect(applied.status).toBe('applied');
    expect(applied.reviewers).toEqual([
      expect.objectContaining({ userId: 'user-2', decision: 'approved' }),
    ]);
    expect(rows[0]?.status).toBe('applied');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SignOffProposal', correlationId: queued.correlationId }),
    );
  });

  it('refuses sign-off from a non-reviewer and review requests from other contributors', async () => {
    const registry = buildRegistry(true);
    const audit = fakeAuditService();
    const { api } = fakeProposalService();
    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Kenen tahansa' },
    });
    const otherContributor = { ...ctx, actingUserId: 'user-5' };
    await expect(
      signOffProposal(readerResolver, api, audit, otherContributor, queued.proposalId, 'approved'),
    ).rejects.toBeInstanceOf(NotARequestedReviewerError);
    await expect(
      requestReview(readerResolver, members, api, audit, otherContributor, queued.proposalId, [
        'vicar@example.test',
      ]),
    ).rejects.toThrow(/approver/);
  });

  it('allows publisher resolver to approve_and_apply', async () => {
    const registry = buildRegistry(true);
    const audit = fakeAuditService();
    const { rows, api } = fakeProposalService();
    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
      names: { fi: 'Apply succeeds' },
    });

    const resolved = await resolveProposal(
      publisherResolver,
      registry,
      api,
      audit,
      new V11ChangeValidator(),
      writeCtx,
      queued.proposalId,
      'approve_and_apply',
      noFourEyes,
    );
    expect(resolved.status).toBe('applied');
    expect(rows[0]?.status).toBe('applied');
  });

  it('returns the applied proposal when the archived service can no longer be read', async () => {
    const adapter = new InMemoryPtvAdapter({
      services: [{ ...service }],
      capabilities: {
        apiVersion: 'v11',
        environment: 'test',
        credentialScope: 'user',
        supportsRead: true,
        supportsWrite: true,
        supportsDraftRead: false,
      },
    });
    // PTV answers 404 for an archived service, public and active reads alike.
    let archived = false;
    const getService = adapter.getService.bind(adapter);
    vi.spyOn(adapter, 'getService').mockImplementation(async (id) =>
      archived ? null : getService(id),
    );
    const applyServiceChange = adapter.applyServiceChange.bind(adapter);
    vi.spyOn(adapter, 'applyServiceChange').mockImplementation(async (proposal) => {
      const result = await applyServiceChange(proposal);
      archived = true;
      return result;
    });
    const registry: PtvAdapterRegistry = { resolve: vi.fn(async () => adapter) };
    const audit = fakeAuditService();
    const { rows, api } = fakeProposalService();

    const queued = await queueProposal(readerResolver, registry, audit, api, ctx, 'svc-1', {
      publishingStatus: 'Archived',
    });
    const resolved = await resolveProposal(
      publisherResolver,
      registry,
      api,
      audit,
      new V11ChangeValidator(),
      writeCtx,
      queued.proposalId,
      'approve_and_apply',
      noFourEyes,
    );

    expect(resolved).toMatchObject({ status: 'applied', current: null, proposed: null, diff: [] });
    expect(resolved.queuedDiff).toEqual(queued.diff);
    expect(rows[0]?.status).toBe('applied');
    const details = await getProposal(editorResolver, registry, api, audit, ctx, queued.proposalId);
    expect(details.status).toBe('applied');
  });

  describe('service_create proposals', () => {
    const newService: Partial<Service> = { ...service };
    delete newService.id;
    delete newService.modifiedAt;
    delete newService.publishingStatus;

    it('queues a new service with its validation, then applies it and records the new id', async () => {
      const registry = buildRegistry(true);
      const audit = fakeAuditService();
      const { rows, api } = fakeProposalService();

      const queued = await queueNewServiceProposal(
        readerResolver,
        audit,
        api,
        new V11ChangeValidator(),
        ctx,
        { ...newService, names: { fi: 'Uusi palvelu' } },
      );
      expect(queued.validation).toEqual({ valid: true, errors: [] });
      expect(queued.proposed.publishingStatus).toBe('Draft');
      expect(queued.diff).toContainEqual({ field: 'names.fi', after: 'Uusi palvelu' });
      expect(rows[0]).toMatchObject({ kind: 'service_create', serviceId: '' });

      const details = await getProposal(
        editorResolver,
        registry,
        api,
        audit,
        ctx,
        queued.proposalId,
      );
      expect(details.current).toBeNull();

      const resolved = await resolveProposal(
        publisherResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        writeCtx,
        queued.proposalId,
        'approve_and_apply',
        noFourEyes,
      );
      expect(resolved.status).toBe('applied');
      expect(resolved.serviceId).not.toBe('');
      expect(audit.recordCalls.map((entry) => entry.action)).toContain('CreateService');
    });

    it('reports validation errors at queue time and refuses to apply an invalid service', async () => {
      const registry = buildRegistry(true);
      const audit = fakeAuditService();
      const { rows, api } = fakeProposalService();
      const queued = await queueNewServiceProposal(
        readerResolver,
        audit,
        api,
        new V11ChangeValidator(),
        ctx,
        { organizationId: 'org-1', names: { fi: 'Ilman luokituksia' }, languages: ['fi'] },
      );
      expect(queued.validation.valid).toBe(false);

      await expect(
        resolveProposal(
          publisherResolver,
          registry,
          api,
          audit,
          new V11ChangeValidator(),
          writeCtx,
          queued.proposalId,
          'approve_and_apply',
          noFourEyes,
        ),
      ).rejects.toThrow(/failed validation/);
      expect(rows[0]?.status).toBe('failed');
    });
  });

  describe('channel_update proposals', () => {
    const channel = {
      id: 'ch-1',
      organizationId: 'org-1',
      channelType: 'Phone' as const,
      publishingStatus: 'Published' as const,
      names: { fi: 'Asiakaspalvelu' },
      descriptions: { fi: 'Kuvaus' },
      languages: ['fi'],
    };
    const adapter = new InMemoryPtvAdapter({
      channels: [channel],
      capabilities: {
        apiVersion: 'v11',
        environment: 'test',
        credentialScope: 'tenant',
        supportsRead: true,
        supportsWrite: true,
        supportsDraftRead: true,
      },
    });
    const registry: PtvAdapterRegistry = { resolve: vi.fn(async () => adapter) };

    it('queues a channel change and applies it on approve_and_apply', async () => {
      const audit = fakeAuditService();
      const { rows, api } = fakeProposalService();
      const queued = await queueChannelProposal(readerResolver, registry, audit, api, ctx, 'ch-1', {
        names: { fi: 'Seurakunnan asiakaspalvelu' },
      });
      expect(queued.diff).toEqual([
        { field: 'names.fi', before: 'Asiakaspalvelu', after: 'Seurakunnan asiakaspalvelu' },
      ]);
      expect(rows[0]).toMatchObject({ kind: 'channel_update', serviceId: 'ch-1' });

      const resolved = await resolveProposal(
        publisherResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        writeCtx,
        queued.proposalId,
        'approve_and_apply',
        noFourEyes,
      );
      expect(resolved.status).toBe('applied');
      expect(resolved.diff).toEqual([]);
      expect((await adapter.getChannel('ch-1'))?.names).toEqual({
        fi: 'Seurakunnan asiakaspalvelu',
      });
    });

    it('refuses fields it cannot write', async () => {
      const { api } = fakeProposalService();
      await expect(
        queueChannelProposal(readerResolver, registry, fakeAuditService(), api, ctx, 'ch-1', {
          channelType: 'WebPage',
        }),
      ).rejects.toThrow(/can't be changed/);
    });
  });

  describe('connection_update proposals', () => {
    function setup() {
      const adapter = new InMemoryPtvAdapter({
        services: [{ ...service, serviceChannelIds: ['ch-1'] }],
        connections: [{ serviceId: 'svc-1', channelId: 'ch-1', chargeType: 'FreeOfCharge' }],
        capabilities: {
          apiVersion: 'v11',
          environment: 'test',
          credentialScope: 'tenant',
          supportsRead: true,
          supportsWrite: true,
          supportsDraftRead: true,
        },
      });
      const registry: PtvAdapterRegistry = { resolve: vi.fn(async () => adapter) };
      return { adapter, registry };
    }
    const hours = [
      {
        type: 'DaysOfTheWeek' as const,
        validForNow: true,
        openingTimes: [{ dayFrom: 'Monday' as const, from: '09:00', to: '12:00' }],
      },
    ];

    it('queues extra-info changes, re-diffs them and applies them on approve_and_apply', async () => {
      const { adapter, registry } = setup();
      const audit = fakeAuditService();
      const { rows, api } = fakeProposalService();
      const queued = await queueConnectionProposal(
        readerResolver,
        registry,
        audit,
        api,
        ctx,
        'svc-1',
        'ch-1',
        { descriptions: { fi: 'Diakoniatyön vastaanotto' }, serviceHours: hours },
      );
      expect(queued.validation.valid).toBe(true);
      expect(queued.diff).toEqual([
        { field: 'descriptions.fi', before: undefined, after: 'Diakoniatyön vastaanotto' },
        { field: 'serviceHours', before: undefined, after: hours },
      ]);
      expect(rows[0]).toMatchObject({
        kind: 'connection_update',
        serviceId: 'svc-1',
        changes: { channelId: 'ch-1' },
      });

      const resolved = await resolveProposal(
        publisherResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        writeCtx,
        queued.proposalId,
        'approve_and_apply',
        noFourEyes,
      );
      expect(resolved.status).toBe('applied');
      expect(resolved.diff).toEqual([]);
      expect((await adapter.getConnectionsFor('svc-1'))[0]).toMatchObject({
        chargeType: 'FreeOfCharge',
        descriptions: { fi: 'Diakoniatyön vastaanotto' },
      });
    });

    it('builds a manual-publishing sheet for the connection on approve_and_export', async () => {
      const { registry } = setup();
      const audit = fakeAuditService();
      const { api } = fakeProposalService();
      const queued = await queueConnectionProposal(
        readerResolver,
        registry,
        audit,
        api,
        ctx,
        'svc-1',
        'ch-1',
        { chargeType: 'Other', chargeDescriptions: { fi: 'Materiaalimaksu 5 euroa' } },
      );
      expect(queued.quality.findings).toEqual([]);
      const approved = await resolveProposal(
        editorResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        ctx,
        queued.proposalId,
        'approve_and_export',
        noFourEyes,
      );
      expect(approved.manualPublish).toMatchObject({
        target: 'Liitoksen lisätiedot',
        ptvId: 'svc-1',
        fields: [
          { field: 'chargeType', label: 'Maksullisuus', after: 'Muu' },
          { field: 'chargeDescriptions', after: 'fi: Materiaalimaksu 5 euroa' },
        ],
      });
      expect(approved.manualPublish?.steps[1]).toContain('ch-1');
      expect(approved.publishedInPtv).toBe(false);
    });

    it('refuses a connection that does not exist, unknown fields and a non-postal address', async () => {
      const { registry } = setup();
      const { api } = fakeProposalService();
      const queue = (channelId: string, changes: Record<string, unknown>) =>
        queueConnectionProposal(
          readerResolver,
          registry,
          fakeAuditService(),
          api,
          ctx,
          'svc-1',
          channelId,
          changes,
        );
      await expect(queue('ch-2', { chargeType: 'Chargeable' })).rejects.toThrow(
        /not connected to channel ch-2/,
      );
      await expect(queue('ch-1', { names: { fi: 'x' } })).rejects.toThrow(/can't be changed/);
      const queued = await queue('ch-1', {
        addresses: [{ kind: 'Other', latitude: '1', longitude: '2' }],
      });
      expect(queued.validation.valid).toBe(false);
    });
  });

  describe('organisation proposals', () => {
    const root = {
      id: 'root',
      publishingStatus: 'Published' as const,
      names: { fi: 'Testin seurakuntayhtymä' },
      summaries: { fi: 'Seurakuntayhtymä' },
      descriptions: { fi: 'Yhtymä hoitaa seurakuntien yhteiset asiat.' },
      organizationType: 'Organization' as const,
      area: {
        areaType: 'LimitedType' as const,
        areas: [{ type: 'Municipality', code: '694' }],
      },
    };
    const parish = {
      id: 'org-1',
      parentOrganizationId: 'root',
      publishingStatus: 'Published' as const,
      names: { fi: 'Testin seurakunta' },
      summaries: { fi: 'Evankelis-luterilainen seurakunta' },
      descriptions: { fi: 'Seurakunta palvelee.' },
      organizationType: 'Organization' as const,
    };
    function setup() {
      const adapter = new InMemoryPtvAdapter({
        organizations: [{ ...root }, { ...parish }],
        capabilities: {
          apiVersion: 'v11',
          environment: 'test',
          credentialScope: 'tenant',
          supportsRead: true,
          supportsWrite: true,
          supportsDraftRead: true,
        },
      });
      const registry: PtvAdapterRegistry = { resolve: vi.fn(async () => adapter) };
      return { adapter, registry };
    }

    it('queues an organisation change and applies it on approve_and_apply', async () => {
      const { adapter, registry } = setup();
      const audit = fakeAuditService();
      const { rows, api } = fakeProposalService();
      const queued = await queueOrganizationProposal(
        readerResolver,
        registry,
        audit,
        api,
        writeCtx,
        'org-1',
        { descriptions: { fi: 'Seurakunta palvelee kaikkia asukkaita.' } },
      );
      expect(queued.validation.valid).toBe(true);
      expect(queued.diff).toEqual([
        {
          field: 'descriptions.fi',
          before: 'Seurakunta palvelee.',
          after: 'Seurakunta palvelee kaikkia asukkaita.',
        },
      ]);
      expect(rows[0]).toMatchObject({ kind: 'organisation_update', serviceId: 'org-1' });
      const resolved = await resolveProposal(
        publisherResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        writeCtx,
        queued.proposalId,
        'approve_and_apply',
        noFourEyes,
      );
      expect(resolved.status).toBe('applied');
      expect(resolved.diff).toEqual([]);
      expect((await adapter.getOrganisation('org-1'))?.descriptions).toEqual({
        fi: 'Seurakunta palvelee kaikkia asukkaita.',
      });
    });

    it("refuses fields only PTV's UI changes", async () => {
      const { registry } = setup();
      const { api } = fakeProposalService();
      await expect(
        queueOrganizationProposal(readerResolver, registry, fakeAuditService(), api, ctx, 'org-1', {
          organizationType: 'Company',
        }),
      ).rejects.toThrow(/can't be changed/);
    });

    it("creates a sub-organisation with the parent's type and area and records its id", async () => {
      const { adapter, registry } = setup();
      const audit = fakeAuditService();
      const { rows, api } = fakeProposalService();
      const queued = await queueNewOrganizationProposal(
        readerResolver,
        registry,
        audit,
        api,
        writeCtx,
        {
          parentOrganizationId: 'root',
          names: { fi: 'Diakoniakeskus' },
          summaries: { fi: 'Seurakuntayhtymän diakoniatyö' },
          descriptions: { fi: 'Diakoniakeskus auttaa, kun tarvitset tukea.' },
        },
      );
      expect(queued.validation.valid).toBe(true);
      expect(queued.proposed).toMatchObject({
        parentOrganizationId: 'root',
        organizationType: 'Organization',
        publishingStatus: 'Draft',
        area: root.area,
      });
      expect(rows[0]).toMatchObject({ kind: 'organisation_create', serviceId: '' });

      const resolved = await resolveProposal(
        publisherResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        writeCtx,
        queued.proposalId,
        'approve_and_apply',
        noFourEyes,
      );
      expect(resolved.status).toBe('applied');
      const created = await adapter.getOrganisation(resolved.serviceId);
      expect(created).toMatchObject({
        parentOrganizationId: 'root',
        names: { fi: 'Diakoniakeskus' },
      });
    });

    it('confirms a sub-organisation entered by hand against its parent and name', async () => {
      const { adapter, registry } = setup();
      const audit = fakeAuditService();
      const { api } = fakeProposalService();
      const queued = await queueNewOrganizationProposal(readerResolver, registry, audit, api, ctx, {
        parentOrganizationId: 'root',
        names: { fi: 'Diakoniakeskus' },
        summaries: { fi: 'Seurakuntayhtymän diakoniatyö' },
        descriptions: { fi: 'Diakoniakeskus auttaa.' },
      });
      const approved = await resolveProposal(
        editorResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        ctx,
        queued.proposalId,
        'approve_and_export',
        noFourEyes,
      );
      expect(approved.manualPublish).toMatchObject({ action: 'create', target: 'Alaorganisaatio' });
      expect(approved.manualPublish?.steps[0]).toContain('root');

      await expect(
        confirmManualPublish(editorResolver, registry, api, audit, ctx, queued.proposalId, 'org-1'),
      ).rejects.toThrow(/does not match/);
      const { organizationId } = await adapter.createOrganization({
        parentOrganizationId: 'root',
        organizationType: 'Organization',
        publishingStatus: 'Published',
        names: { fi: 'Diakoniakeskus' },
      });
      const confirmed = await confirmManualPublish(
        editorResolver,
        registry,
        api,
        audit,
        ctx,
        queued.proposalId,
        organizationId,
      );
      expect(confirmed.status).toBe('applied');
    });

    it('refuses a sixth level of sub-organisations', async () => {
      const top: Organization = { ...parish };
      delete top.parentOrganizationId;
      const chain = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].map((id, i, all) =>
        i === 0 ? { ...top, id } : { ...top, id, parentOrganizationId: all[i - 1]! },
      );
      const adapter = new InMemoryPtvAdapter({
        organizations: chain,
        capabilities: setup().adapter.getCapabilities(),
      });
      const registry: PtvAdapterRegistry = { resolve: vi.fn(async () => adapter) };
      const { api } = fakeProposalService();
      await expect(
        queueNewOrganizationProposal(readerResolver, registry, fakeAuditService(), api, ctx, {
          parentOrganizationId: 'l5',
          names: { fi: 'Liian syvä' },
        }),
      ).rejects.toThrow(/at most 5 levels/);
    });
  });

  describe('comments', () => {
    it('lets a contributor comment, shows comments on the proposal, and audits them', async () => {
      const registry = buildRegistry();
      const audit = fakeAuditService();
      const { api } = fakeProposalService();
      const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
        names: { fi: 'Kommentoitava' },
      });

      await commentOnProposal(
        readerResolver,
        api,
        audit,
        ctx,
        queued.proposalId,
        '  Hyvä muutos  ',
      );
      const details = await getProposal(
        editorResolver,
        registry,
        api,
        audit,
        ctx,
        queued.proposalId,
      );

      expect(details.comments.map((comment) => comment.body)).toEqual(['Hyvä muutos']);
      expect(audit.recordCalls.find((entry) => entry.action === 'CommentProposal')).toMatchObject({
        correlationId: queued.correlationId,
        result: 'Commented',
      });
    });

    it('refuses an empty comment and a viewer', async () => {
      const registry = buildRegistry();
      const audit = fakeAuditService();
      const { api } = fakeProposalService();
      const queued = await queueProposal(readerResolver, registry, audit, api, ctx, service.id, {
        names: { fi: 'X' },
      });
      await expect(
        commentOnProposal(readerResolver, api, audit, ctx, queued.proposalId, '   '),
      ).rejects.toThrow('Comment is empty');
      await expect(
        commentOnProposal(async () => 'viewer', api, audit, ctx, queued.proposalId, 'Hei'),
      ).rejects.toThrow("requires at least 'contributor' role");
    });
  });
});

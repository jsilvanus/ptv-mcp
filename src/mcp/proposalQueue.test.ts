import { describe, expect, it, vi } from 'vitest';
import { PtvAdapterResolutionError, type PtvAdapterRegistry } from '../ptv/registry.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import type { Service } from '../ptv/domain.js';
import { fakeAuditService } from './testing/fakeAuditService.js';
import {
  getProposal,
  listProposals,
  queueProposal,
  resolveProposal,
  type ResolveProposalAction,
} from './proposalQueue.js';
import type { MembershipRoleResolver } from './authorization.js';
import type {
  ProposalRecord,
  ProposalService,
  ProposalStatus,
} from '../proposals/proposalService.js';
import { V11ChangeValidator } from '../validation/changeValidator.js';
import { queueNewServiceProposal } from './newServiceProposal.js';
import { queueChannelProposal } from './channelProposal.js';

const ctx = { tenantId: 'tenant-1', environment: 'test' as const, actingUserId: 'user-1' };
/** approve_and_apply needs a selected write API before the registry's role check runs. */
const writeCtx = { ...ctx, writeApiVersion: 'v11' };
const readerResolver: MembershipRoleResolver = async () => 'contributor';
const editorResolver: MembershipRoleResolver = async () => 'approver';
const publisherResolver: MembershipRoleResolver = async () => 'publisher';

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
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return row;
    }),
    listForTenant: vi.fn(async (_tenantId: string, options?: { status?: ProposalStatus }) =>
      rows.filter((row) => (options?.status ? row.status === options.status : true)),
    ),
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
      ),
    ).rejects.toMatchObject({ reason: 'not_authorized' });

    expect(rows[0]?.status).toBe('pending');
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
});

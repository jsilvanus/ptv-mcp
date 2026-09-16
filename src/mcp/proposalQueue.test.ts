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
import type { ProposalRecord, ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { V11ChangeValidator } from '../validation/changeValidator.js';

const ctx = { tenantId: 'tenant-1', environment: 'test' as const, actingUserId: 'user-1' };
const readerResolver: MembershipRoleResolver = async () => 'reader';
const editorResolver: MembershipRoleResolver = async () => 'editor';
const publisherResolver: MembershipRoleResolver = async () => 'publisher';

const service: Service = {
  id: 'svc-1',
  organizationId: 'org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Vanha nimi' },
  summaries: {},
  descriptions: {},
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
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
      async (_tenantId: string, proposalId: string, status: Exclude<ProposalStatus, 'pending'>) => {
        const row = rows.find((entry) => entry.id === proposalId);
        if (!row) {
          throw new Error('not found');
        }
        row.status = status;
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

    const queued = await queueProposal(
      readerResolver,
      registry,
      audit,
      api,
      ctx,
      service.id,
      { names: { fi: 'Uusi nimi' } },
    );
    expect(queued.status).toBe('pending');
    expect(rows).toHaveLength(1);

    const listed = await listProposals(editorResolver, api, ctx, 'pending');
    expect(listed).toHaveLength(1);

    const reviewed = await getProposal(editorResolver, registry, api, audit, ctx, queued.proposalId);
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
    const queued = await queueProposal(
      readerResolver,
      registry,
      audit,
      api,
      ctx,
      service.id,
      { names: { fi: 'Apply me' } },
    );

    await expect(
      resolveProposal(
        editorResolver,
        registry,
        api,
        audit,
        new V11ChangeValidator(),
        ctx,
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
    const queued = await queueProposal(
      readerResolver,
      registry,
      audit,
      api,
      ctx,
      service.id,
      { names: { fi: 'Apply succeeds' } },
    );

    const resolved = await resolveProposal(
      publisherResolver,
      registry,
      api,
      audit,
      new V11ChangeValidator(),
      ctx,
      queued.proposalId,
      'approve_and_apply',
    );
    expect(resolved.status).toBe('applied');
    expect(rows[0]?.status).toBe('applied');
  });
});

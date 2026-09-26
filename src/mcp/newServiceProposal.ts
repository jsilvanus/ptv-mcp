import type { AuditService } from '../audit/auditService.js';
import type { ApplyServiceChangeResult, NewService } from '../ptv/adapter.js';
import type { Service } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService } from '../proposals/proposalService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { MembershipRoleResolver } from './authorization.js';
import { auditedApply, queueKindProposal, type QueuedFields } from './proposalPipeline.js';
import { diffFields, type ServiceDiffEntry } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

/** Everything empty: what a new service is diffed against. */
const EMPTY_SERVICE: Service = {
  id: '',
  organizationId: '',
  serviceType: 'Service',
  publishingStatus: 'Draft',
  names: {},
  summaries: {},
  descriptions: {},
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: [],
  serviceChannelIds: [],
};

/**
 * Fills in the fields a caller may leave out of a new service. It starts as
 * a Draft unless the proposal says Published.
 */
export function normalizeNewService(input: Partial<Service>): NewService {
  const merged: Partial<Service> = { ...EMPTY_SERVICE, ...input };
  delete merged.id;
  delete merged.modifiedAt;
  return merged as NewService;
}

/** A NewService as a Service with no id, for the validator and diff. */
export function asService(service: NewService): Service {
  return { ...service, id: '' };
}

/** Validated at queue time, so problems show before anyone approves. */
export type QueuedNewServiceResult = {
  proposed: NewService;
  diff: ServiceDiffEntry[];
} & QueuedFields;

/**
 * `ptv_propose_new_service`: queues a `service_create` proposal. Nothing
 * is written to PTV until an Approver+ approves it with approve_and_apply
 * (which also needs a write-capable adapter, i.e. Publisher).
 */
export async function queueNewServiceProposal(
  resolveRole: MembershipRoleResolver,
  auditService: AuditService,
  proposalService: ProposalService,
  validator: ChangeValidator,
  ctx: ToolContext,
  input: Partial<Service>,
  correlationId?: string,
  reviewItemId?: string,
): Promise<QueuedNewServiceResult> {
  const { prepared, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService, validator },
    ctx,
    {
      kind: 'service_create',
      input,
      targetId: '',
      prepare: async () => {
        const proposed = normalizeNewService(input);
        return { proposed, diff: diffFields(EMPTY_SERVICE, proposed) };
      },
      changes: ({ proposed }) => proposed,
      correlationId,
      reviewItemId,
    },
  );
  return { ...prepared, ...queued };
}

/**
 * Validates and creates the service through a write-capable adapter
 * (Publisher role, enforced by the registry), auditing the outcome either
 * way. Mirrors applyChanges for updates.
 */
export async function createNewService(
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  validator: ChangeValidator,
  ctx: ToolContext,
  service: NewService,
  correlationId: string,
): Promise<ApplyServiceChangeResult> {
  return auditedApply({ registry, auditService, validator }, ctx, 'service_create', async () => ({
    correlationId,
    proposed: service,
    target: { createdId: (result: ApplyServiceChangeResult) => result.serviceId },
    write: (adapter) => adapter.createService(service),
  }));
}

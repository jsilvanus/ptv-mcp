import { checkService, type QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyServiceChangeResult, NewService } from '../ptv/adapter.js';
import type { Service } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import { ValidationFailedError, WriteApiNotSelectedError } from './applyOrExport.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import { diffService, type ServiceDiffEntry } from './proposeChanges.js';
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
function asService(service: NewService): Service {
  return { ...service, id: '' };
}

export interface QueuedNewServiceResult {
  proposed: NewService;
  diff: ServiceDiffEntry[];
  /** Validation run at queue time so problems show before anyone approves. */
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
  /** Automated content checks on the proposed service. */
  quality: QualityReport;
}

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
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const proposed = normalizeNewService(input);
  const diff = diffService(EMPTY_SERVICE, proposed);
  const validation = validator.validate(asService(proposed));
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeNewService',
    resourceType: 'Service',
    afterState: { proposed, validationErrors: validation.errors },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: 'service_create',
    serviceId: '',
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: proposed,
    queuedDiff: diff,
    correlationId: auditEntry.correlationId,
    ...(reviewItemId ? { reviewItemId } : {}),
  });
  return {
    proposed,
    diff,
    validation,
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
    quality: checkService(proposed),
  };
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
  if (!ctx.writeApiVersion) {
    throw new WriteApiNotSelectedError();
  }
  const validation = validator.validate(asService(service));
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateNewService',
    resourceType: 'Service',
    apiVersion: validator.apiVersion,
    afterState: { errors: validation.errors },
    result: validation.valid ? 'Valid' : 'Invalid',
    correlationId,
  });
  if (!validation.valid) {
    throw new ValidationFailedError(validation.errors);
  }

  const writeAdapter = await registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.writeApiVersion,
    operation: 'write',
    actingUserId: ctx.actingUserId,
  });
  const capabilities = writeAdapter.getCapabilities();
  try {
    const result = await writeAdapter.createService(service);
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'CreateService',
      resourceType: 'Service',
      resourceId: result.serviceId,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      afterState: service,
      result: 'Success',
      correlationId,
    });
    return result;
  } catch (err) {
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'CreateService',
      resourceType: 'Service',
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      afterState: service,
      result: 'Failed',
      correlationId,
    });
    throw err;
  }
}

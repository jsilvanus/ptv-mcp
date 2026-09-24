import { checkChannel, type QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyChannelChangeResult, NewChannel } from '../ptv/adapter.js';
import type { Service, ServiceChannel } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { validateChannel } from '../validation/changeValidator.js';
import { ValidationFailedError, WriteApiNotSelectedError } from './applyOrExport.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import { CHANNEL_TYPE_FIELDS, UnsupportedChannelFieldError } from './channelProposal.js';
import { diffService, type ServiceDiffEntry } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

const CHANNEL_TYPES: ServiceChannel['channelType'][] = [
  'EChannel',
  'Phone',
  'PrintableForm',
  'ServiceLocation',
  'WebPage',
];

/** Fields a new channel may set besides its type's writable fields. */
const CREATE_ONLY_FIELDS = ['channelType', 'organizationId', 'serviceIds'];

export class InvalidNewChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNewChannelError';
  }
}

/**
 * Fills in what a caller may leave out of a new channel: it starts as a
 * Draft, shared with other organisations (DVV's recommendation), with empty
 * texts. The channel type and organisation are required.
 */
export function normalizeNewChannel(input: Partial<NewChannel>): NewChannel {
  const type = input.channelType;
  if (!type || !CHANNEL_TYPES.includes(type)) {
    throw new InvalidNewChannelError(`channelType must be one of ${CHANNEL_TYPES.join(', ')}`);
  }
  const unsupported = Object.keys(input).filter(
    (field) => !CHANNEL_TYPE_FIELDS[type].includes(field) && !CREATE_ONLY_FIELDS.includes(field),
  );
  if (unsupported.length > 0) throw new UnsupportedChannelFieldError(unsupported, type);
  return {
    publishingStatus: 'Draft',
    names: {},
    summaries: {},
    descriptions: {},
    languages: [],
    isVisibleForAll: true,
    ...input,
    channelType: type,
    organizationId: input.organizationId ?? '',
  } as NewChannel;
}

/** A NewChannel as a ServiceChannel with no id, for validation, checks and the diff. */
export function asChannel(channel: NewChannel): ServiceChannel {
  const fields: Partial<NewChannel> = { ...channel };
  delete fields.serviceIds;
  return { ...(fields as NewChannel), id: '' };
}

const EMPTY_CHANNEL = { names: {}, summaries: {}, descriptions: {}, languages: [] };

export interface QueuedNewChannelResult {
  proposed: NewChannel;
  diff: ServiceDiffEntry[];
  /** Validation run at queue time so problems show before anyone approves. */
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  quality: QualityReport;
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
}

/**
 * `ptv_propose_new_channel`: queues a `channel_create` proposal. Nothing is
 * written to PTV until an Approver+ resolves it (approve_and_apply also
 * needs a write-capable adapter, i.e. Publisher).
 */
export async function queueNewChannelProposal(
  resolveRole: MembershipRoleResolver,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  input: Partial<NewChannel>,
  correlationId?: string,
  reviewItemId?: string,
): Promise<QueuedNewChannelResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const proposed = normalizeNewChannel(input);
  const channel = asChannel(proposed);
  const diff = diffService(
    EMPTY_CHANNEL as unknown as Service,
    channelFieldsOf(proposed) as unknown as Partial<Service>,
  );
  const validation = validateChannel(channel, true);
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeNewChannel',
    resourceType: 'ServiceChannel',
    afterState: { proposed, validationErrors: validation.errors },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: 'channel_create',
    serviceId: '',
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: proposed as unknown as Partial<Service>,
    queuedDiff: diff,
    correlationId: auditEntry.correlationId,
    ...(reviewItemId ? { reviewItemId } : {}),
  });
  return {
    proposed,
    diff,
    validation,
    quality: checkChannel(channel),
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
  };
}

/** Every set field except the id-like ones, for the diff of a new channel. */
function channelFieldsOf(channel: NewChannel): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(channel).filter(([, value]) => value !== undefined && value !== ''),
  );
}

/**
 * Validates and creates the channel through a write-capable adapter
 * (Publisher, enforced by the registry), auditing the outcome either way.
 */
export async function createNewChannel(
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  channel: NewChannel,
  correlationId: string,
): Promise<ApplyChannelChangeResult> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const validation = validateChannel(asChannel(channel), true);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateNewChannel',
    resourceType: 'ServiceChannel',
    afterState: { errors: validation.errors },
    result: validation.valid ? 'Valid' : 'Invalid',
    correlationId,
  });
  if (!validation.valid) throw new ValidationFailedError(validation.errors);

  const writeAdapter = await registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.writeApiVersion,
    operation: 'write',
    actingUserId: ctx.actingUserId,
  });
  const capabilities = writeAdapter.getCapabilities();
  const audit = (result: 'Success' | 'Failed', channelId?: string) =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'CreateChannel',
      resourceType: 'ServiceChannel',
      ...(channelId ? { resourceId: channelId } : {}),
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      afterState: channel,
      result,
      correlationId,
    });
  try {
    const result = await writeAdapter.createChannel(channel);
    await audit('Success', result.channelId);
    return result;
  } catch (err) {
    await audit('Failed');
    throw err;
  }
}

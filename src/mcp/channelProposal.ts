import type { AuditService } from '../audit/auditService.js';
import type { ApplyChannelChangeResult } from '../ptv/adapter.js';
import type { PtvContentId, Service, ServiceChannel } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { validateChannel } from '../validation/changeValidator.js';
import { ValidationFailedError, WriteApiNotSelectedError } from './applyOrExport.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import { diffService, type ServiceDiffEntry } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

/** Only these channel fields are written (see src/ptv/v11/channelWriteMapping.ts). */
export const WRITABLE_CHANNEL_FIELDS = [
  'names',
  'descriptions',
  'languages',
  'publishingStatus',
] as const;

export class ChannelNotFoundError extends Error {
  constructor(channelId: string) {
    super(`PTV service channel not found: ${channelId}`);
    this.name = 'ChannelNotFoundError';
  }
}

export class UnsupportedChannelFieldError extends Error {
  constructor(fields: string[]) {
    super(
      `These channel fields can't be changed through PTV-MCP: ${fields.join(', ')}. ` +
        `Writable fields: ${WRITABLE_CHANNEL_FIELDS.join(', ')}.`,
    );
    this.name = 'UnsupportedChannelFieldError';
  }
}

export interface PreparedChannelProposal {
  channelId: PtvContentId;
  current: ServiceChannel;
  proposed: ServiceChannel;
  diff: ServiceDiffEntry[];
}

/** Reads the channel's latest version, merges `changes` and diffs, like prepareProposal for services. */
export async function prepareChannelProposal(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  channelId: PtvContentId,
  changes: Partial<ServiceChannel>,
): Promise<PreparedChannelProposal> {
  const unsupported = Object.keys(changes).filter(
    (field) => !(WRITABLE_CHANNEL_FIELDS as readonly string[]).includes(field),
  );
  if (unsupported.length > 0) throw new UnsupportedChannelFieldError(unsupported);

  const adapter = await registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.readApiVersion ?? ctx.apiVersion ?? 'v11',
    operation: 'read',
    actingUserId: ctx.actingUserId,
  });
  const current = await adapter.getChannel(channelId);
  if (!current) throw new ChannelNotFoundError(channelId);
  const proposed: ServiceChannel = { ...current, ...changes };
  // Same field semantics as a service's names/descriptions/languages.
  const diff = diffService(current as unknown as Service, changes as unknown as Partial<Service>);
  return { channelId, current, proposed, diff };
}

export interface QueuedChannelProposalResult extends PreparedChannelProposal {
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
}

/** `ptv_propose_channel_changes`: queues a `channel_update` proposal (Reader+). */
export async function queueChannelProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  channelId: PtvContentId,
  changes: Partial<ServiceChannel>,
  correlationId?: string,
): Promise<QueuedChannelProposalResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'reader');
  const prepared = await prepareChannelProposal(registry, ctx, channelId, changes);
  const validation = validateChannel(prepared.proposed);
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeChannelChange',
    resourceType: 'ServiceChannel',
    resourceId: channelId,
    afterState: { diff: prepared.diff, validationErrors: validation.errors },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: 'channel_update',
    serviceId: channelId,
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: changes as Partial<Service>,
    queuedDiff: prepared.diff,
    correlationId: auditEntry.correlationId,
  });
  return {
    ...prepared,
    validation,
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
  };
}

/**
 * Re-diffs against the channel's current state, validates, and writes
 * through a write-capable adapter (Publisher, enforced by the registry),
 * auditing the outcome either way.
 */
export async function applyChannelChanges(
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  channelId: PtvContentId,
  changes: Partial<ServiceChannel>,
  correlationId: string,
): Promise<ApplyChannelChangeResult> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const { current, proposed } = await prepareChannelProposal(registry, ctx, channelId, changes);
  const validation = validateChannel(proposed);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateChannelChange',
    resourceType: 'ServiceChannel',
    resourceId: channelId,
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
  const audit = (result: 'Success' | 'Failed') =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ApplyChannelChange',
      resourceType: 'ServiceChannel',
      resourceId: channelId,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      beforeState: current,
      ...(result === 'Success' ? { afterState: proposed } : {}),
      result,
      correlationId,
    });
  try {
    const result = await writeAdapter.applyChannelChange({ channelId, changes });
    await audit('Success');
    return result;
  } catch (err) {
    await audit('Failed');
    throw err;
  }
}

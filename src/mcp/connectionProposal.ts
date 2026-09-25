import { resolveReadAdapter, resolveWriteAdapter } from './toolContext.js';
import { assertLocalizedTextFields } from './localizedInput.js';
import { checkConnection, type QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyConnectionChangeResult } from '../ptv/adapter.js';
import type { Connection, ConnectionDetails, PtvContentId, Service } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { validateConnectionDetails } from '../validation/channelRules.js';
import { ValidationFailedError, WriteApiNotSelectedError } from './applyOrExport.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import { diffService, type ServiceDiffEntry } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

/** The extra-info fields a `connection_update` proposal may change. */
export const CONNECTION_DETAIL_FIELDS = [
  'chargeType',
  'descriptions',
  'chargeDescriptions',
  'serviceHours',
  'emails',
  'phoneNumbers',
  'webPages',
  'addresses',
] as const;

/**
 * A `connection_update` proposal's stored `changes`: the channel (the
 * service is the proposal's `serviceId`) and the extra-info fields that
 * change.
 */
export type ConnectionChanges = Partial<ConnectionDetails> & { channelId: PtvContentId };

export class ConnectionNotFoundError extends Error {
  constructor(serviceId: PtvContentId, channelId: PtvContentId) {
    super(
      `Service ${serviceId} is not connected to channel ${channelId}. Connect them first (the service's serviceChannelIds), then change the connection's extra info.`,
    );
    this.name = 'ConnectionNotFoundError';
  }
}

export class UnsupportedConnectionFieldError extends Error {
  constructor(fields: string[]) {
    super(
      `These connection fields can't be changed: ${fields.join(', ')}. Writable fields: ${CONNECTION_DETAIL_FIELDS.join(', ')}.`,
    );
    this.name = 'UnsupportedConnectionFieldError';
  }
}

export interface PreparedConnectionProposal {
  serviceId: PtvContentId;
  channelId: PtvContentId;
  current: Connection;
  proposed: Connection;
  diff: ServiceDiffEntry[];
}

/** Splits stored `changes` into the channel id and the detail changes. */
export function splitConnectionChanges(changes: ConnectionChanges): {
  channelId: PtvContentId;
  details: Partial<ConnectionDetails>;
} {
  const { channelId, ...details } = changes;
  return { channelId, details };
}

/** Reads the connection, merges `changes` and diffs, like prepareChannelProposal. */
export async function prepareConnectionProposal(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  serviceId: PtvContentId,
  channelId: PtvContentId,
  changes: Partial<ConnectionDetails>,
): Promise<PreparedConnectionProposal> {
  const unsupported = Object.keys(changes).filter(
    (field) => !(CONNECTION_DETAIL_FIELDS as readonly string[]).includes(field),
  );
  if (unsupported.length > 0) throw new UnsupportedConnectionFieldError(unsupported);

  const adapter = await resolveReadAdapter(registry, ctx);
  const current = (await adapter.getConnectionsFor(serviceId)).find(
    (connection) => connection.serviceId === serviceId && connection.channelId === channelId,
  );
  if (!current) throw new ConnectionNotFoundError(serviceId, channelId);
  const proposed: Connection = { ...current, ...changes };
  // `descriptions` diffs per language, like a service's; the rest whole.
  const diff = diffService(current as unknown as Service, changes as unknown as Partial<Service>);
  return { serviceId, channelId, current, proposed, diff };
}

export interface QueuedConnectionProposalResult extends PreparedConnectionProposal {
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
  /** Automated content checks on the proposed extra info. */
  quality: QualityReport;
}

/** `ptv_propose_connection_changes`: queues a `connection_update` proposal (Contributor+). */
export async function queueConnectionProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  serviceId: PtvContentId,
  channelId: PtvContentId,
  changes: Partial<ConnectionDetails>,
  correlationId?: string,
  reviewItemId?: string,
): Promise<QueuedConnectionProposalResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  assertLocalizedTextFields(changes);
  const prepared = await prepareConnectionProposal(registry, ctx, serviceId, channelId, changes);
  const errors = validateConnectionDetails(prepared.proposed);
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeConnectionChange',
    resourceType: 'Connection',
    resourceId: `${serviceId}/${channelId}`,
    afterState: { diff: prepared.diff, validationErrors: errors },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const stored: ConnectionChanges = { channelId, ...changes };
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: 'connection_update',
    serviceId,
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: stored as unknown as Partial<Service>,
    queuedDiff: prepared.diff,
    correlationId: auditEntry.correlationId,
    ...(reviewItemId ? { reviewItemId } : {}),
  });
  return {
    ...prepared,
    validation: { valid: errors.length === 0, errors },
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
    quality: checkConnection(prepared.proposed),
  };
}

/**
 * Re-diffs against the connection's current state, validates, and writes
 * through a write-capable adapter (Publisher, enforced by the registry),
 * auditing the outcome either way.
 */
export async function applyConnectionChanges(
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  serviceId: PtvContentId,
  channelId: PtvContentId,
  changes: Partial<ConnectionDetails>,
  correlationId: string,
): Promise<ApplyConnectionChangeResult> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const { current, proposed } = await prepareConnectionProposal(
    registry,
    ctx,
    serviceId,
    channelId,
    changes,
  );
  const errors = validateConnectionDetails(proposed);
  const resourceId = `${serviceId}/${channelId}`;
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateConnectionChange',
    resourceType: 'Connection',
    resourceId,
    afterState: { errors },
    result: errors.length === 0 ? 'Valid' : 'Invalid',
    correlationId,
  });
  if (errors.length > 0) throw new ValidationFailedError(errors);

  const writeAdapter = await resolveWriteAdapter(registry, ctx);
  const capabilities = writeAdapter.getCapabilities();
  const audit = (result: 'Success' | 'Failed') =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ApplyConnectionChange',
      resourceType: 'Connection',
      resourceId,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      beforeState: current,
      ...(result === 'Success' ? { afterState: proposed } : {}),
      result,
      correlationId,
    });
  try {
    const result = await writeAdapter.applyConnectionChange({ serviceId, channelId, changes });
    await audit('Success');
    return result;
  } catch (err) {
    await audit('Failed');
    throw err;
  }
}

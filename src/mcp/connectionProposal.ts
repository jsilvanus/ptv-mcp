import { resolveReadAdapter } from './toolContext.js';
import type { QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyConnectionChangeResult } from '../ptv/adapter.js';
import type { Connection, ConnectionDetails, PtvContentId } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import type { MembershipRoleResolver } from './authorization.js';
import { auditedApply, queueKindProposal } from './proposalPipeline.js';
import { diffFields, type ServiceDiffEntry } from './proposeChanges.js';
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

/** A `connection_update` proposal's changes as its handler reads them. */
export interface ConnectionChange {
  channelId: PtvContentId;
  details: Partial<ConnectionDetails>;
}

/** A connection's audit resource id. */
function connectionResourceId(serviceId: PtvContentId, channelId: PtvContentId): string {
  return `${serviceId}/${channelId}`;
}

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
export function splitConnectionChanges(changes: ConnectionChanges): ConnectionChange {
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
  const diff = diffFields<ConnectionDetails>(current, changes);
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
  const { prepared, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService },
    ctx,
    {
      kind: 'connection_update',
      input: changes,
      targetId: serviceId,
      resourceId: connectionResourceId(serviceId, channelId),
      prepare: () => prepareConnectionProposal(registry, ctx, serviceId, channelId, changes),
      changes: () => ({ channelId, details: changes }),
      correlationId,
      reviewItemId,
    },
  );
  return { ...prepared, ...queued };
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
  return auditedApply({ registry, auditService }, ctx, 'connection_update', async () => {
    const { current, proposed } = await prepareConnectionProposal(
      registry,
      ctx,
      serviceId,
      channelId,
      changes,
    );
    return {
      correlationId,
      proposed,
      target: { resourceId: connectionResourceId(serviceId, channelId), before: current },
      write: (adapter) => adapter.applyConnectionChange({ serviceId, channelId, changes }),
    };
  });
}

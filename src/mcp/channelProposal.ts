import { resolveReadAdapter } from './toolContext.js';
import type { QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyChannelChangeResult } from '../ptv/adapter.js';
import type { PtvContentId, ServiceChannel } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import type { MembershipRoleResolver } from './authorization.js';
import { auditedApply, queueKindProposal } from './proposalPipeline.js';
import { diffFields, type ServiceDiffEntry } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

const COMMON_CHANNEL_FIELDS = [
  'names',
  'summaries',
  'descriptions',
  'languages',
  'publishingStatus',
  'isVisibleForAll',
  'serviceHours',
] as const;

/**
 * The fields each channel type carries and PTV-MCP writes (see
 * src/ptv/v11/channelWriteMapping.ts). Service locations have no support
 * contacts (käytön tuki); their own phone numbers and emails are the
 * contacts.
 */
export const CHANNEL_TYPE_FIELDS: Record<ServiceChannel['channelType'], readonly string[]> = {
  EChannel: [
    ...COMMON_CHANNEL_FIELDS,
    'supportPhones',
    'supportEmails',
    'urls',
    'requiresAuthentication',
    'requiresSignature',
    'signatureQuantity',
    'accessibility',
  ],
  WebPage: [...COMMON_CHANNEL_FIELDS, 'supportPhones', 'supportEmails', 'urls', 'accessibility'],
  Phone: [...COMMON_CHANNEL_FIELDS, 'supportPhones', 'supportEmails', 'urls', 'phoneNumbers'],
  PrintableForm: [
    ...COMMON_CHANNEL_FIELDS,
    'supportPhones',
    'supportEmails',
    'webPages',
    'formIdentifiers',
    'formFiles',
    'deliveryAddresses',
  ],
  ServiceLocation: [...COMMON_CHANNEL_FIELDS, 'webPages', 'phoneNumbers', 'emails', 'addresses'],
};

/** Every writable channel field of some type. */
export const WRITABLE_CHANNEL_FIELDS = [
  ...new Set(Object.values(CHANNEL_TYPE_FIELDS).flat()),
] as readonly string[];

export class ChannelNotFoundError extends Error {
  constructor(channelId: string) {
    super(`PTV service channel not found: ${channelId}`);
    this.name = 'ChannelNotFoundError';
  }
}

export class UnsupportedChannelFieldError extends Error {
  constructor(fields: string[], type?: ServiceChannel['channelType']) {
    super(
      `These channel fields can't be changed through PTV-MCP${type ? ` on a ${type} channel` : ''}: ${fields.join(', ')}. ` +
        `Writable fields: ${(type ? CHANNEL_TYPE_FIELDS[type] : WRITABLE_CHANNEL_FIELDS).join(', ')}.`,
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

  const adapter = await resolveReadAdapter(registry, ctx);
  const current = await adapter.getChannel(channelId);
  if (!current) throw new ChannelNotFoundError(channelId);
  const wrongType = Object.keys(changes).filter(
    (field) => !CHANNEL_TYPE_FIELDS[current.channelType].includes(field),
  );
  if (wrongType.length > 0) throw new UnsupportedChannelFieldError(wrongType, current.channelType);
  const proposed: ServiceChannel = { ...current, ...changes };
  // Same field semantics as a service's names/descriptions/languages.
  const diff = diffFields(current, changes);
  return { channelId, current, proposed, diff };
}

export interface QueuedChannelProposalResult extends PreparedChannelProposal {
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
  /** Automated content checks on the proposed channel. */
  quality: QualityReport;
}

/** `ptv_propose_channel_changes`: queues a `channel_update` proposal (Contributor+). */
export async function queueChannelProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  channelId: PtvContentId,
  changes: Partial<ServiceChannel>,
  correlationId?: string,
  reviewItemId?: string,
): Promise<QueuedChannelProposalResult> {
  const { prepared, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService },
    ctx,
    {
      kind: 'channel_update',
      input: changes,
      targetId: channelId,
      resourceId: channelId,
      prepare: () => prepareChannelProposal(registry, ctx, channelId, changes),
      changes: () => changes,
      correlationId,
      reviewItemId,
    },
  );
  return { ...prepared, ...queued };
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
  return auditedApply({ registry, auditService }, ctx, 'channel_update', async () => {
    const { current, proposed } = await prepareChannelProposal(registry, ctx, channelId, changes);
    return {
      correlationId,
      proposed,
      target: { resourceId: channelId, before: current },
      write: (adapter) => adapter.applyChannelChange({ channelId, changes }),
    };
  });
}

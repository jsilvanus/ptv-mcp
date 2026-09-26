import { resolveReadAdapter, resolveWriteAdapter } from './toolContext.js';
import { assertLocalizedTextFields } from './localizedInput.js';
import { checkChannel, type QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyChannelChangeResult } from '../ptv/adapter.js';
import type { PtvContentId, Service, ServiceChannel } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { validateChannel } from '../validation/changeValidator.js';
import { ValidationFailedError, WriteApiNotSelectedError } from './applyOrExport.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
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
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  assertLocalizedTextFields(changes);
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
    ...(reviewItemId ? { reviewItemId } : {}),
  });
  return {
    ...prepared,
    validation,
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
    quality: checkChannel(prepared.proposed),
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

  const writeAdapter = await resolveWriteAdapter(registry, ctx);
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

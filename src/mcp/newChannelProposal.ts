import { WriteApiNotSelectedError } from './toolContext.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyChannelChangeResult, NewChannel } from '../ptv/adapter.js';
import type { ServiceChannel } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService } from '../proposals/proposalService.js';
import type { MembershipRoleResolver } from './authorization.js';
import { CHANNEL_TYPE_FIELDS, UnsupportedChannelFieldError } from './channelProposal.js';
import { auditedApply, queueKindProposal, type QueuedFields } from './proposalPipeline.js';
import { diffFields, setFields, unknownFields, type ServiceDiffEntry } from './proposeChanges.js';
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
  const unsupported = unknownFields(input, [...CHANNEL_TYPE_FIELDS[type], ...CREATE_ONLY_FIELDS]);
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

/** Validated at queue time, so problems show before anyone approves. */
export type QueuedNewChannelResult = {
  proposed: NewChannel;
  diff: ServiceDiffEntry[];
} & QueuedFields;

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
  const { prepared, validation, quality, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService },
    ctx,
    {
      kind: 'channel_create',
      input,
      targetId: '',
      prepare: async () => {
        if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
        const proposed = normalizeNewChannel(input);
        return {
          proposed,
          diff: diffFields<Record<string, unknown>>(EMPTY_CHANNEL, setFields(proposed)),
        };
      },
      changes: ({ proposed }) => proposed,
      correlationId,
      reviewItemId,
    },
  );
  return { ...prepared, validation, quality, ...queued };
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
  return auditedApply({ registry, auditService }, ctx, 'channel_create', async () => ({
    correlationId,
    proposed: channel,
    target: { createdId: (result: ApplyChannelChangeResult) => result.channelId },
    write: (adapter) => adapter.createChannel(channel),
  }));
}

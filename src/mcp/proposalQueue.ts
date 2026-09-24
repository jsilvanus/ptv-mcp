import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { PtvContentId, Service, ServiceChannel } from '../ptv/domain.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import {
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  ProposalService,
  type ProposalComment,
  type ProposalKind,
  type ProposalRecord,
  type ProposalStatus,
} from '../proposals/proposalService.js';
import type { NewService } from '../ptv/adapter.js';
import { createNewService, normalizeNewService } from './newServiceProposal.js';
import {
  applyChannelChanges,
  ChannelNotFoundError,
  prepareChannelProposal,
} from './channelProposal.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import type { ToolContext } from './toolContext.js';
import { applyChanges, exportForManualPublish } from './applyOrExport.js';
import {
  prepareProposal,
  ServiceNotFoundError,
  type ProposeChangesResult,
} from './proposeChanges.js';

export type ResolveProposalAction = 'approve_and_export' | 'approve_and_apply' | 'reject';

export interface QueuedProposeChangesResult extends ProposeChangesResult {
  proposalId: string;
  status: ProposalStatus;
}

export interface ProposalSummary {
  id: string;
  kind: ProposalKind;
  serviceId: string;
  environment: 'test' | 'production';
  proposedByUserId: string;
  status: ProposalStatus;
  correlationId: string;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProposalDetails extends ProposalSummary {
  changes: Partial<Service>;
  queuedDiff: ProposeChangesResult['diff'];
  diff: ProposeChangesResult['diff'];
  /**
   * `null` for a service_create proposal (there is nothing to diff against)
   * and when the service or channel can no longer be read, e.g. after an
   * approved archive: PTV then returns 404 for it.
   */
  current: Service | ServiceChannel | null;
  /** `null` when the service or channel can no longer be read (see `current`). */
  proposed: Service | NewService | ServiceChannel | null;
  /** Oldest first. */
  comments: ProposalComment[];
}

export class InvalidResolveActionError extends Error {
  constructor(action: string) {
    super(
      `Invalid resolve action '${action}'. Use one of: approve_and_export, approve_and_apply, reject`,
    );
    this.name = 'InvalidResolveActionError';
  }
}

function toSummary(proposal: ProposalRecord): ProposalSummary {
  return {
    id: proposal.id,
    kind: proposal.kind,
    serviceId: proposal.serviceId,
    environment: proposal.environment,
    proposedByUserId: proposal.proposedByUserId,
    status: proposal.status,
    correlationId: proposal.correlationId,
    resolvedByUserId: proposal.resolvedByUserId,
    resolvedAt: proposal.resolvedAt,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

async function proposalDetails(
  registry: PtvAdapterRegistry,
  proposalService: ProposalService,
  proposal: ProposalRecord,
  ctx: ToolContext,
): Promise<ProposalDetails> {
  const [details, comments] = await Promise.all([
    proposalDiffDetails(registry, proposal, ctx),
    proposalService.listComments(ctx.tenantId, proposal.id),
  ]);
  return { ...details, comments };
}

async function proposalDiffDetails(
  registry: PtvAdapterRegistry,
  proposal: ProposalRecord,
  ctx: ToolContext,
): Promise<Omit<ProposalDetails, 'comments'>> {
  try {
    return await liveProposalDetails(registry, proposal, ctx);
  } catch (err) {
    if (!(err instanceof ServiceNotFoundError || err instanceof ChannelNotFoundError)) throw err;
    // The target is gone (archived services and channels 404), but the
    // proposal record itself is still reviewable.
    return {
      ...toSummary(proposal),
      changes: proposal.changes,
      queuedDiff: proposal.queuedDiff,
      diff: [],
      current: null,
      proposed: null,
    };
  }
}

async function liveProposalDetails(
  registry: PtvAdapterRegistry,
  proposal: ProposalRecord,
  ctx: ToolContext,
): Promise<Omit<ProposalDetails, 'comments'>> {
  if (proposal.kind === 'service_create') {
    return {
      ...toSummary(proposal),
      changes: proposal.changes,
      queuedDiff: proposal.queuedDiff,
      diff: proposal.queuedDiff,
      current: null,
      proposed: normalizeNewService(proposal.changes),
    };
  }
  if (proposal.kind === 'channel_update') {
    const prepared = await prepareChannelProposal(
      registry,
      ctx,
      proposal.serviceId,
      proposal.changes as Partial<ServiceChannel>,
    );
    return {
      ...toSummary(proposal),
      changes: proposal.changes,
      queuedDiff: proposal.queuedDiff,
      diff: prepared.diff,
      current: prepared.current,
      proposed: prepared.proposed,
    };
  }
  const prepared = await prepareProposal(
    registry,
    { ...ctx, environment: proposal.environment },
    proposal.serviceId,
    proposal.changes,
  );
  return {
    ...toSummary(proposal),
    changes: proposal.changes,
    queuedDiff: proposal.queuedDiff,
    diff: prepared.diff,
    current: prepared.current,
    proposed: prepared.proposed,
  };
}

export async function queueProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  serviceId: PtvContentId,
  changes: Partial<Service>,
  correlationId?: string,
): Promise<QueuedProposeChangesResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const prepared = await prepareProposal(registry, ctx, serviceId, changes);
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeServiceChange',
    resourceType: 'Service',
    resourceId: serviceId,
    afterState: { diff: prepared.diff },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    serviceId,
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes,
    queuedDiff: prepared.diff,
    correlationId: auditEntry.correlationId,
  });

  return {
    ...prepared,
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
  };
}

export async function listProposals(
  resolveRole: MembershipRoleResolver,
  proposalService: ProposalService,
  ctx: ToolContext,
  status?: ProposalStatus,
): Promise<ProposalSummary[]> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const proposals = await proposalService.listForTenant(ctx.tenantId, {
    ...(status ? { status } : {}),
  });
  return proposals.map(toSummary);
}

export async function getProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  proposalService: ProposalService,
  auditService: AuditService,
  ctx: ToolContext,
  proposalId: string,
): Promise<ProposalDetails> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ReviewProposal',
    resourceType: 'Proposal',
    resourceId: proposal.id,
    result: 'Viewed',
    correlationId: proposal.correlationId,
  });
  return proposalDetails(registry, proposalService, proposal, ctx);
}

export class InvalidCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommentError';
  }
}

/** Longest comment accepted; a review note, not a document. */
export const MAX_COMMENT_LENGTH = 4000;

/**
 * Adds a comment to a proposal (Contributor+), whatever its status, so the
 * reasons for a decision stay with it. Audited under the proposal's
 * correlation id.
 */
export async function commentOnProposal(
  resolveRole: MembershipRoleResolver,
  proposalService: ProposalService,
  auditService: AuditService,
  ctx: ToolContext,
  proposalId: string,
  body: string,
): Promise<ProposalComment> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const text = body.trim();
  if (text === '') throw new InvalidCommentError('Comment is empty');
  if (text.length > MAX_COMMENT_LENGTH) {
    throw new InvalidCommentError(`Comment is longer than ${MAX_COMMENT_LENGTH} characters`);
  }
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  const comment = await proposalService.addComment(
    ctx.tenantId,
    proposal.id,
    ctx.actingUserId,
    text,
  );
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'CommentProposal',
    resourceType: 'Proposal',
    resourceId: proposal.id,
    afterState: { commentId: comment.id, body: text },
    result: 'Commented',
    correlationId: proposal.correlationId,
  });
  return comment;
}

export async function resolveProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  proposalService: ProposalService,
  auditService: AuditService,
  validator: ChangeValidator,
  ctx: ToolContext,
  proposalId: string,
  action: ResolveProposalAction,
): Promise<ProposalDetails> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'approver');
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  const proposalCtx: ToolContext = { ...ctx, environment: proposal.environment };

  if (action === 'reject') {
    const rejected = await proposalService.markResolved(
      ctx.tenantId,
      proposalId,
      'rejected',
      ctx.actingUserId,
    );
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposalId,
      result: 'Rejected',
      correlationId: proposal.correlationId,
    });
    return proposalDetails(registry, proposalService, rejected, proposalCtx);
  }

  if (proposal.kind === 'channel_update') {
    return resolveChannelProposal(registry, proposalService, auditService, ctx, proposal, action);
  }

  if (proposal.kind === 'service_create') {
    return resolveNewServiceProposal(
      registry,
      proposalService,
      auditService,
      validator,
      ctx,
      proposal,
      action,
    );
  }

  if (action === 'approve_and_export') {
    await exportForManualPublish(
      resolveRole,
      registry,
      auditService,
      proposalCtx,
      proposal.serviceId,
      proposal.changes,
      proposal.correlationId,
    );
    const approved = await proposalService.markResolved(
      ctx.tenantId,
      proposalId,
      'approved',
      ctx.actingUserId,
    );
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposalId,
      result: 'ApprovedForManualPublish',
      correlationId: proposal.correlationId,
    });
    return proposalDetails(registry, proposalService, approved, proposalCtx);
  }

  if (action === 'approve_and_apply') {
    try {
      await applyChanges(
        resolveRole,
        registry,
        auditService,
        validator,
        proposalCtx,
        proposal.serviceId,
        proposal.changes,
        proposal.correlationId,
      );
    } catch (err) {
      if (err instanceof PtvAdapterResolutionError && err.reason === 'not_authorized') {
        throw err;
      }
      await proposalService.markResolved(ctx.tenantId, proposalId, 'failed', ctx.actingUserId);
      await auditService.record({
        tenantId: ctx.tenantId,
        userId: ctx.actingUserId,
        action: 'ResolveProposal',
        resourceType: 'Proposal',
        resourceId: proposalId,
        result: 'Failed',
        correlationId: proposal.correlationId,
      });
      throw err;
    }

    const applied = await proposalService.markResolved(
      ctx.tenantId,
      proposalId,
      'applied',
      ctx.actingUserId,
    );
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposalId,
      result: 'Applied',
      correlationId: proposal.correlationId,
    });
    return proposalDetails(registry, proposalService, applied, proposalCtx);
  }

  throw new InvalidResolveActionError(action);
}

/**
 * approve_and_export marks a new service approved for manual entry in
 * PTV's UI (the proposal holds the full service); approve_and_apply
 * creates it and records PTV's new id on the proposal.
 */
async function resolveNewServiceProposal(
  registry: PtvAdapterRegistry,
  proposalService: ProposalService,
  auditService: AuditService,
  validator: ChangeValidator,
  ctx: ToolContext,
  proposal: ProposalRecord,
  action: Exclude<ResolveProposalAction, 'reject'>,
): Promise<ProposalDetails> {
  const proposalCtx: ToolContext = { ...ctx, environment: proposal.environment };
  const service = normalizeNewService(proposal.changes);

  if (action === 'approve_and_export') {
    const approved = await proposalService.markResolved(
      ctx.tenantId,
      proposal.id,
      'approved',
      ctx.actingUserId,
    );
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposal.id,
      afterState: service,
      result: 'ApprovedForManualPublish',
      correlationId: proposal.correlationId,
    });
    return proposalDetails(registry, proposalService, approved, proposalCtx);
  }

  if (action !== 'approve_and_apply') throw new InvalidResolveActionError(action);

  let createdId: string;
  try {
    const result = await createNewService(
      registry,
      auditService,
      validator,
      proposalCtx,
      service,
      proposal.correlationId,
    );
    createdId = result.serviceId;
  } catch (err) {
    if (err instanceof PtvAdapterResolutionError && err.reason === 'not_authorized') {
      throw err;
    }
    await proposalService.markResolved(ctx.tenantId, proposal.id, 'failed', ctx.actingUserId);
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposal.id,
      result: 'Failed',
      correlationId: proposal.correlationId,
    });
    throw err;
  }

  const applied = await proposalService.markResolved(
    ctx.tenantId,
    proposal.id,
    'applied',
    ctx.actingUserId,
    createdId,
  );
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ResolveProposal',
    resourceType: 'Proposal',
    resourceId: proposal.id,
    afterState: { serviceId: createdId },
    result: 'Applied',
    correlationId: proposal.correlationId,
  });
  return proposalDetails(registry, proposalService, applied, proposalCtx);
}

/**
 * approve_and_export marks a channel change approved for manual entry in
 * PTV's UI; approve_and_apply re-diffs against the channel's current state
 * and writes it.
 */
async function resolveChannelProposal(
  registry: PtvAdapterRegistry,
  proposalService: ProposalService,
  auditService: AuditService,
  ctx: ToolContext,
  proposal: ProposalRecord,
  action: Exclude<ResolveProposalAction, 'reject'>,
): Promise<ProposalDetails> {
  const proposalCtx: ToolContext = { ...ctx, environment: proposal.environment };
  const changes = proposal.changes as Partial<ServiceChannel>;
  const record = (result: string) =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposal.id,
      result,
      correlationId: proposal.correlationId,
    });

  if (action === 'approve_and_export') {
    const approved = await proposalService.markResolved(
      ctx.tenantId,
      proposal.id,
      'approved',
      ctx.actingUserId,
    );
    await record('ApprovedForManualPublish');
    return proposalDetails(registry, proposalService, approved, proposalCtx);
  }
  if (action !== 'approve_and_apply') throw new InvalidResolveActionError(action);

  try {
    await applyChannelChanges(
      registry,
      auditService,
      proposalCtx,
      proposal.serviceId,
      changes,
      proposal.correlationId,
    );
  } catch (err) {
    if (err instanceof PtvAdapterResolutionError && err.reason === 'not_authorized') {
      throw err;
    }
    await proposalService.markResolved(ctx.tenantId, proposal.id, 'failed', ctx.actingUserId);
    await record('Failed');
    throw err;
  }
  const applied = await proposalService.markResolved(
    ctx.tenantId,
    proposal.id,
    'applied',
    ctx.actingUserId,
  );
  await record('Applied');
  return proposalDetails(registry, proposalService, applied, proposalCtx);
}

export function isProposalQueueError(
  err: unknown,
): err is
  | ProposalNotFoundError
  | ProposalAlreadyResolvedError
  | InvalidResolveActionError
  | InvalidCommentError {
  return (
    err instanceof ProposalNotFoundError ||
    err instanceof ProposalAlreadyResolvedError ||
    err instanceof InvalidResolveActionError ||
    err instanceof InvalidCommentError
  );
}

import { resolveReadAdapter } from './toolContext.js';
import { assertLocalizedTextFields } from './localizedInput.js';
import { asChannel, createNewChannel, normalizeNewChannel } from './newChannelProposal.js';
import type { NewChannel, NewOrganization } from '../ptv/adapter.js';
import {
  checkChannel,
  checkConnection,
  checkOrganization,
  checkService,
  type QualityReport,
  type ServiceCheckContext,
} from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type {
  Connection,
  Organization,
  PtvContentId,
  Service,
  ServiceChannel,
} from '../ptv/domain.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import { ROLE_RANK, type MembershipRole } from '../auth/rbac.js';
import {
  ProposalAlreadyResolvedError,
  ProposalService,
  type ProposalComment,
  type ProposalKind,
  type ProposalReviewer,
  type ProposalRecord,
  type ProposalStatus,
} from '../proposals/proposalService.js';
import type { NewService } from '../ptv/adapter.js';
import { createNewService, normalizeNewService } from './newServiceProposal.js';
import { serviceCheckContext } from '../quality/serviceCheckContext.js';
import {
  applyOrganizationChanges,
  createNewOrganization,
  OrganizationNotFoundError,
  prepareOrganizationProposal,
} from './organizationProposal.js';
import {
  applyConnectionChanges,
  ConnectionNotFoundError,
  prepareConnectionProposal,
  splitConnectionChanges,
  type ConnectionChanges,
} from './connectionProposal.js';
import {
  applyChannelChanges,
  ChannelNotFoundError,
  prepareChannelProposal,
} from './channelProposal.js';
import {
  FourEyesError,
  requireTenantRole,
  type FourEyesResolver,
  type MembershipRoleResolver,
} from './authorization.js';
import type { ToolContext } from './toolContext.js';
import { applyChanges, exportForManualPublish } from './applyOrExport.js';
import { buildManualPublishSheet, type ManualPublishSheet } from './manualPublish.js';
import { isCreateKind } from './proposalKinds.js';
import {
  prepareProposal,
  ServiceNotFoundError,
  type ProposeChangesResult,
} from './proposeChanges.js';

export type ResolveProposalAction = 'approve_and_export' | 'approve_and_apply' | 'reject';

export interface QueuedProposeChangesResult extends ProposeChangesResult {
  proposalId: string;
  status: ProposalStatus;
  /** Automated content checks on the proposed service. */
  quality: QualityReport;
}

/**
 * Automated content checks on a proposal's `proposed` entity. A channel
 * update doesn't know the channel's connections, so its Q-STRUCT-5 is left
 * to the review item and ptv_check_quality; a new channel is connected to
 * exactly its `serviceIds`.
 */
export function proposedQuality(
  kind: ProposalKind,
  proposed: Service | NewService | ServiceChannel | Connection | Organization | null,
  serviceContext: ServiceCheckContext = {},
): QualityReport | null {
  if (!proposed) return null;
  if (kind === 'organisation_update' || kind === 'organisation_create') {
    return checkOrganization(proposed as Organization);
  }
  if (kind === 'connection_update') return checkConnection(proposed as Connection);
  if (kind === 'channel_create') {
    const serviceIds = (proposed as { serviceIds?: string[] }).serviceIds;
    return checkChannel(proposed as ServiceChannel, {
      connectedServiceCount: serviceIds?.length ?? 0,
      creating: true,
    });
  }
  if (kind === 'channel_update') return checkChannel(proposed as ServiceChannel);
  return checkService(proposed as Service | NewService, {
    ...serviceContext,
    creating: kind === 'service_create',
  });
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
  /** Set when the proposal was made for a review campaign item. */
  reviewItemId: string | null;
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
  current: Service | ServiceChannel | Connection | Organization | null;
  /** `null` when the service or channel can no longer be read (see `current`). */
  proposed: Service | NewService | ServiceChannel | Connection | Organization | null;
  /** Oldest first. */
  comments: ProposalComment[];
  /** Required reviewers; approving waits until all have `approved`. */
  reviewers: ProposalReviewer[];
  /** Automated content checks on `proposed` (src/quality/contentChecks.ts); null without it. */
  quality: QualityReport | null;
  /**
   * An approved (exported) proposal: what to enter in PTV's own UI. For an
   * update it lists what still differs from PTV, so it empties as the
   * change is entered.
   */
  manualPublish: ManualPublishSheet | null;
  /**
   * An approved update: true once PTV already holds every change (confirm
   * it with ptv_confirm_manual_publish). null for new items, which are
   * checked by the id given when confirming, and for other statuses.
   */
  publishedInPtv: boolean | null;
}

export class InvalidResolveActionError extends Error {
  constructor(action: string) {
    super(
      `Invalid resolve action '${action}'. Use one of: approve_and_export, approve_and_apply, reject`,
    );
    this.name = 'InvalidResolveActionError';
  }
}

export function toSummary(proposal: ProposalRecord): ProposalSummary {
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
    reviewItemId: proposal.reviewItemId ?? null,
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
  const [details, comments, reviewers] = await Promise.all([
    proposalDiffDetails(registry, proposal, ctx),
    proposalService.listComments(ctx.tenantId, proposal.id),
    proposalService.listReviewers(ctx.tenantId, proposal.id),
  ]);
  const serviceContext =
    proposal.kind === 'service_update' || proposal.kind === 'service_create'
      ? await proposedServiceContext(registry, ctx, details.proposed as Service | null)
      : undefined;
  return {
    ...details,
    comments,
    reviewers,
    quality: proposedQuality(proposal.kind, details.proposed, serviceContext),
    ...manualPublishState(proposal, details),
  };
}

/** The organisation and general description a proposed service is checked against. */
async function proposedServiceContext(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  service: Service | null,
): Promise<ServiceCheckContext> {
  if (!service) return {};
  const adapter = await resolveReadAdapter(registry, ctx).catch(() => null);
  return adapter ? serviceCheckContext(adapter, service) : {};
}

function manualPublishState(
  proposal: ProposalRecord,
  details: DiffDetails,
): Pick<ProposalDetails, 'manualPublish' | 'publishedInPtv'> {
  if (proposal.status !== 'approved') return { manualPublish: null, publishedInPtv: null };
  if (proposal.kind === 'connection_update') {
    const { channelId } = splitConnectionChanges(proposal.changes as unknown as ConnectionChanges);
    return {
      manualPublish: buildManualPublishSheet({
        kind: proposal.kind,
        diff: details.diff,
        ptvId: proposal.serviceId,
        names: {},
        languages: [],
        channelId,
      }),
      publishedInPtv: details.current ? details.diff.length === 0 : null,
    };
  }
  const entity = (details.proposed ?? details.current) as
    (Partial<ServiceChannel> & { names?: Service['names']; parentOrganizationId?: string }) | null;
  const creating = isCreateKind(proposal.kind);
  // A new sub-organisation is added under its parent.
  const organizationId =
    proposal.kind === 'organisation_create' ? entity?.parentOrganizationId : entity?.organizationId;
  return {
    manualPublish: buildManualPublishSheet({
      kind: proposal.kind,
      diff: creating ? proposal.queuedDiff : details.diff,
      ptvId: creating ? null : proposal.serviceId,
      names: ((details.current ?? entity) as { names?: Service['names'] } | null)?.names ?? {},
      languages: Object.keys(entity?.names ?? {}),
      ...(entity?.channelType ? { channelType: entity.channelType } : {}),
      ...(organizationId ? { organizationId } : {}),
    }),
    publishedInPtv: publishedInPtv(proposal, details, creating),
  };
}

/**
 * An update is in PTV once nothing differs; an archive once the item can
 * no longer be read. New items are checked by the id given when confirming.
 */
function publishedInPtv(
  proposal: ProposalRecord,
  details: DiffDetails,
  creating: boolean,
): boolean | null {
  if (creating) return null;
  if (details.current) return details.diff.length === 0;
  const archived =
    (proposal.changes as { publishingStatus?: string }).publishingStatus === 'Archived';
  return archived ? true : null;
}

type DiffDetails = Omit<
  ProposalDetails,
  'comments' | 'reviewers' | 'quality' | 'manualPublish' | 'publishedInPtv'
>;

type LiveDiff = Pick<DiffDetails, 'diff' | 'current' | 'proposed'>;

/** The proposal re-diffed against PTV now, read in the proposal's own environment. */
async function proposalDiffDetails(
  registry: PtvAdapterRegistry,
  proposal: ProposalRecord,
  ctx: ToolContext,
): Promise<DiffDetails> {
  const base = {
    ...toSummary(proposal),
    changes: proposal.changes,
    queuedDiff: proposal.queuedDiff,
  };
  try {
    const { diff, current, proposed } = await liveDiff(registry, proposal, {
      ...ctx,
      environment: proposal.environment,
    });
    return { ...base, diff, current, proposed };
  } catch (err) {
    if (!(
      err instanceof ServiceNotFoundError ||
      err instanceof ChannelNotFoundError ||
      err instanceof ConnectionNotFoundError ||
      err instanceof OrganizationNotFoundError
    )) {
      throw err;
    }
    // The target is gone (archived services and channels 404), but the
    // proposal record itself is still reviewable.
    return { ...base, diff: [], current: null, proposed: null };
  }
}

/**
 * New items diff against nothing (the queue-time diff stands); updates
 * re-read the target and re-diff.
 */
async function liveDiff(
  registry: PtvAdapterRegistry,
  proposal: ProposalRecord,
  ctx: ToolContext,
): Promise<LiveDiff> {
  const created = (proposed: DiffDetails['proposed']): LiveDiff => ({
    diff: proposal.queuedDiff,
    current: null,
    proposed,
  });
  const changes = proposal.changes as unknown;
  switch (proposal.kind) {
    case 'channel_create':
      return created(asChannel(normalizeNewChannel(changes as Partial<NewChannel>)));
    case 'service_create':
      return created(normalizeNewService(proposal.changes));
    case 'organisation_create':
      // Stored normalized at queue time (the parent's defaults filled in).
      return created({ ...(changes as NewOrganization), id: '' });
    case 'organisation_update':
      return prepareOrganizationProposal(
        registry,
        ctx,
        proposal.serviceId,
        changes as Partial<Organization>,
      );
    case 'connection_update': {
      const { channelId, details } = splitConnectionChanges(changes as ConnectionChanges);
      return prepareConnectionProposal(registry, ctx, proposal.serviceId, channelId, details);
    }
    case 'channel_update':
      return prepareChannelProposal(
        registry,
        ctx,
        proposal.serviceId,
        changes as Partial<ServiceChannel>,
      );
    case 'service_update':
      return prepareProposal(registry, ctx, proposal.serviceId, proposal.changes);
  }
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
  reviewItemId?: string,
): Promise<QueuedProposeChangesResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  assertLocalizedTextFields(changes);
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
    ...(reviewItemId ? { reviewItemId } : {}),
  });

  return {
    ...prepared,
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
    quality: proposedQuality(
      'service_update',
      prepared.proposed,
      await proposedServiceContext(registry, ctx, prepared.proposed),
    ) as QualityReport,
  };
}

export async function listProposals(
  resolveRole: MembershipRoleResolver,
  proposalService: ProposalService,
  ctx: ToolContext,
  status?: ProposalStatus,
  /** Only pending proposals waiting for the acting user's sign-off. */
  waitingForMe = false,
): Promise<ProposalSummary[]> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  if (waitingForMe) {
    return (await proposalService.listAwaitingReview(ctx.tenantId, ctx.actingUserId)).map(
      toSummary,
    );
  }
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

export class ReviewsPendingError extends Error {
  constructor(waiting: ProposalReviewer[]) {
    super(
      `Waiting for required reviewers: ${waiting
        .map((reviewer) => `${reviewer.userName} (${reviewer.decision})`)
        .join(
          ', ',
        )}. Approve after every reviewer has signed off with approved; reject is always possible.`,
    );
    this.name = 'ReviewsPendingError';
  }
}

export class InvalidReviewRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewRequestError';
  }
}

function requirePending(proposal: ProposalRecord): void {
  if (proposal.status !== 'pending') {
    throw new ProposalAlreadyResolvedError(proposal.id, proposal.status);
  }
}

/** A tenant member as far as review requests need one. */
export interface ReviewCandidate {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
}

/** Lists a tenant's members; production passes `TenantService.listMembers`. */
export type MemberLister = (tenantId: string) => Promise<ReviewCandidate[]>;

/** Members who can be named as reviewers: Contributor (Ehdottaja) or above. */
export async function listReviewCandidates(
  resolveRole: MembershipRoleResolver,
  listMembers: MemberLister,
  ctx: ToolContext,
): Promise<ReviewCandidate[]> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  return (await listMembers(ctx.tenantId))
    .filter((member) => ROLE_RANK[member.role] >= ROLE_RANK.contributor)
    .sort((a, b) => a.name.localeCompare(b.name, 'fi'));
}

/**
 * Names required reviewers (by user id or email) for a pending proposal.
 * The proposer or an Approver+ may ask; each reviewer must be a
 * Contributor+ in the tenant and not the proposer. Audited under the
 * proposal's correlation id.
 */
export async function requestReview(
  resolveRole: MembershipRoleResolver,
  listMembers: MemberLister,
  proposalService: ProposalService,
  auditService: AuditService,
  ctx: ToolContext,
  proposalId: string,
  reviewers: string[],
): Promise<ProposalReviewer[]> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  requirePending(proposal);
  if (proposal.proposedByUserId !== ctx.actingUserId) {
    await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'approver');
  }
  if (reviewers.length === 0) throw new InvalidReviewRequestError('Name at least one reviewer');
  const candidates = await listReviewCandidates(resolveRole, listMembers, ctx);
  const userIds = new Set<string>();
  for (const reviewer of reviewers) {
    const key = reviewer.trim().toLowerCase();
    const match = candidates.find(
      (candidate) => candidate.userId === reviewer.trim() || candidate.email.toLowerCase() === key,
    );
    if (!match) {
      throw new InvalidReviewRequestError(
        `${reviewer} is not a Contributor (Ehdottaja) or above in this organisation. Possible reviewers: ${candidates
          .map((candidate) => `${candidate.name} <${candidate.email}>`)
          .join(', ')}`,
      );
    }
    if (match.userId === proposal.proposedByUserId) {
      throw new InvalidReviewRequestError('The proposer cannot review their own proposal');
    }
    userIds.add(match.userId);
  }
  const reviewerUserIds = [...userIds];
  const result = await proposalService.addReviewers(
    ctx.tenantId,
    proposal.id,
    reviewerUserIds,
    ctx.actingUserId,
  );
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'RequestReview',
    resourceType: 'Proposal',
    resourceId: proposal.id,
    afterState: { reviewerUserIds },
    result: 'Requested',
    correlationId: proposal.correlationId,
  });
  return result;
}

export type SignOffDecision = 'approved' | 'changes_requested';

/**
 * A requested reviewer's sign-off (Hyväksyn / Pyydän muutoksia) on a
 * pending proposal; can be changed until the proposal is resolved.
 */
export async function signOffProposal(
  resolveRole: MembershipRoleResolver,
  proposalService: ProposalService,
  auditService: AuditService,
  ctx: ToolContext,
  proposalId: string,
  decision: SignOffDecision,
  comment?: string,
): Promise<ProposalReviewer[]> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const text = comment?.trim() || null;
  if (text && text.length > MAX_COMMENT_LENGTH) {
    throw new InvalidCommentError(`Comment is longer than ${MAX_COMMENT_LENGTH} characters`);
  }
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  requirePending(proposal);
  const reviewers = await proposalService.recordDecision(
    ctx.tenantId,
    proposal.id,
    ctx.actingUserId,
    decision,
    text,
  );
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'SignOffProposal',
    resourceType: 'Proposal',
    resourceId: proposal.id,
    afterState: { decision, comment: text },
    result: decision === 'approved' ? 'Approved' : 'ChangesRequested',
    correlationId: proposal.correlationId,
  });
  return reviewers;
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
  requireFourEyes: FourEyesResolver,
): Promise<ProposalDetails> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'approver');
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  const proposalCtx: ToolContext = { ...ctx, environment: proposal.environment };

  // Four-eyes: approving your own proposal is refused; rejecting (withdrawing) it is fine.
  if (
    action !== 'reject' &&
    proposal.proposedByUserId === ctx.actingUserId &&
    (await requireFourEyes(ctx.tenantId))
  ) {
    throw new FourEyesError(
      'Four-eyes review: you cannot approve a proposal you created. Another Hyväksyjä or Julkaisija must resolve it (you can still reject it).',
    );
  }

  if (action !== 'reject') {
    const waiting = (await proposalService.listReviewers(ctx.tenantId, proposalId)).filter(
      (reviewer) => reviewer.decision !== 'approved',
    );
    if (waiting.length > 0) throw new ReviewsPendingError(waiting);
  }

  const record = (result: string, afterState?: object) =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ResolveProposal',
      resourceType: 'Proposal',
      resourceId: proposalId,
      ...(afterState ? { afterState } : {}),
      result,
      correlationId: proposal.correlationId,
    });

  if (action === 'reject') {
    const rejected = await proposalService.markResolved(
      ctx.tenantId,
      proposalId,
      'rejected',
      ctx.actingUserId,
    );
    await record('Rejected');
    return proposalDetails(registry, proposalService, rejected, proposalCtx);
  }

  if (action === 'approve_and_export') {
    // A service change is re-validated before export; the other kinds were
    // validated when queued and are re-diffed on every read.
    if (proposal.kind === 'service_update') {
      await exportForManualPublish(
        resolveRole,
        registry,
        auditService,
        proposalCtx,
        proposal.serviceId,
        proposal.changes,
        proposal.correlationId,
      );
    }
    const approved = await proposalService.markResolved(
      ctx.tenantId,
      proposalId,
      'approved',
      ctx.actingUserId,
    );
    await record(
      'ApprovedForManualPublish',
      proposal.kind === 'service_create' ? normalizeNewService(proposal.changes) : undefined,
    );
    return proposalDetails(registry, proposalService, approved, proposalCtx);
  }

  if (action !== 'approve_and_apply') throw new InvalidResolveActionError(action);

  let outcome: AppliedOutcome;
  try {
    outcome = await applyApproved(
      { resolveRole, registry, auditService, validator },
      proposalCtx,
      proposal,
    );
  } catch (err) {
    // Not being allowed to write leaves the proposal pending for a Publisher.
    if (err instanceof PtvAdapterResolutionError && err.reason === 'not_authorized') {
      throw err;
    }
    await proposalService.markResolved(ctx.tenantId, proposalId, 'failed', ctx.actingUserId);
    await record('Failed');
    throw err;
  }
  const applied = await proposalService.markResolved(
    ctx.tenantId,
    proposalId,
    'applied',
    ctx.actingUserId,
    outcome.createdId,
  );
  await record('Applied', outcome.afterState);
  return proposalDetails(registry, proposalService, applied, proposalCtx);
}

interface AppliedOutcome {
  /** PTV's id for a created item, recorded on the proposal. */
  createdId?: string;
  afterState?: object;
}

/**
 * Writes an approved proposal through a write-capable adapter (Publisher,
 * enforced by the registry): updates re-diff against PTV first, new items
 * are created and their id returned.
 */
async function applyApproved(
  deps: {
    resolveRole: MembershipRoleResolver;
    registry: PtvAdapterRegistry;
    auditService: AuditService;
    validator: ChangeValidator;
  },
  ctx: ToolContext,
  proposal: ProposalRecord,
): Promise<AppliedOutcome> {
  const { registry, auditService } = deps;
  const { serviceId: targetId, correlationId } = proposal;
  const changes = proposal.changes as unknown;
  switch (proposal.kind) {
    case 'service_update':
      await applyChanges(
        deps.resolveRole,
        registry,
        auditService,
        deps.validator,
        ctx,
        targetId,
        proposal.changes,
        correlationId,
      );
      return {};
    case 'service_create': {
      const { serviceId } = await createNewService(
        registry,
        auditService,
        deps.validator,
        ctx,
        normalizeNewService(proposal.changes),
        correlationId,
      );
      return { createdId: serviceId, afterState: { serviceId } };
    }
    case 'channel_update':
      await applyChannelChanges(
        registry,
        auditService,
        ctx,
        targetId,
        changes as Partial<ServiceChannel>,
        correlationId,
      );
      return {};
    case 'channel_create': {
      const { channelId } = await createNewChannel(
        registry,
        auditService,
        ctx,
        normalizeNewChannel(changes as Partial<NewChannel>),
        correlationId,
      );
      return { createdId: channelId, afterState: { channelId } };
    }
    case 'connection_update': {
      const { channelId, details } = splitConnectionChanges(changes as ConnectionChanges);
      await applyConnectionChanges(
        registry,
        auditService,
        ctx,
        targetId,
        channelId,
        details,
        correlationId,
      );
      return {};
    }
    case 'organisation_update':
      await applyOrganizationChanges(
        registry,
        auditService,
        ctx,
        targetId,
        changes as Partial<Organization>,
        correlationId,
      );
      return {};
    case 'organisation_create': {
      const { organizationId } = await createNewOrganization(
        registry,
        auditService,
        ctx,
        changes as NewOrganization,
        correlationId,
      );
      return { createdId: organizationId, afterState: { organizationId } };
    }
  }
}

export class ManualPublishCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualPublishCheckError';
  }
}

/**
 * `ptv_confirm_manual_publish`: closes an approved (exported) proposal once
 * a person has entered it in PTV's own UI. Checks PTV first: an update must
 * leave nothing to diff; a new service or channel is found by the id PTV
 * gave it (`ptvId`), must belong to the organisation and carry the proposed
 * names, and the id is recorded on the proposal. The proposal becomes
 * `applied`. Approver+ (Hyväksyjä), like approving it.
 */
export async function confirmManualPublish(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  proposalService: ProposalService,
  auditService: AuditService,
  ctx: ToolContext,
  proposalId: string,
  ptvId?: string,
): Promise<ProposalDetails> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'approver');
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  if (proposal.status !== 'approved') {
    throw new ManualPublishCheckError(
      `Proposal ${proposalId} is ${proposal.status}; only an approved (exported) proposal is published by hand.`,
    );
  }
  const proposalCtx: ToolContext = { ...ctx, environment: proposal.environment };
  let createdId: string | undefined;
  if (isCreateKind(proposal.kind)) {
    if (!ptvId?.trim()) {
      throw new ManualPublishCheckError(
        'Give ptvId: the id PTV gave the new item (shown in its address in PTV).',
      );
    }
    createdId = ptvId.trim();
    await checkCreatedItem(registry, proposalCtx, proposal, createdId);
  } else {
    const details = await proposalDiffDetails(registry, proposal, proposalCtx);
    const state = manualPublishState(proposal, details);
    if (state.publishedInPtv !== true) {
      const fields = details.diff.map((entry) => entry.field).join(', ');
      throw new ManualPublishCheckError(
        details.current
          ? `PTV does not have the whole change yet; still different: ${fields}. Enter these (see the manual-publishing sheet in ptv_get_proposal) and publish, then confirm again.`
          : 'The item can no longer be read from PTV, so the change cannot be checked.',
      );
    }
  }
  const published = await proposalService.markPublished(ctx.tenantId, proposalId, createdId);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ConfirmManualPublish',
    resourceType: 'Proposal',
    resourceId: proposalId,
    ...(createdId ? { afterState: { ptvId: createdId } } : {}),
    result: 'Published',
    correlationId: proposal.correlationId,
  });
  return proposalDetails(registry, proposalService, published, proposalCtx);
}

async function checkCreatedItem(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  proposal: ProposalRecord,
  ptvId: string,
): Promise<void> {
  const adapter = await resolveReadAdapter(registry, ctx);
  const changes = proposal.changes as Partial<Service> & { parentOrganizationId?: string };
  // What to read back, and the organisation it must belong to: a service's
  // or channel's own organisation, a sub-organisation's parent.
  const target = {
    service_create: {
      what: 'service',
      expectedOrg: changes.organizationId,
      read: () => adapter.getService(ptvId),
    },
    channel_create: {
      what: 'channel',
      expectedOrg: changes.organizationId,
      read: () => adapter.getChannel(ptvId),
    },
    organisation_create: {
      what: 'organisation',
      expectedOrg: changes.parentOrganizationId,
      read: async () => {
        const org = await adapter.getOrganisation(ptvId);
        return org && { organizationId: org.parentOrganizationId ?? '', names: org.names };
      },
    },
  }[proposal.kind as 'service_create' | 'channel_create' | 'organisation_create'];
  const found: { organizationId: string; names: Service['names'] } | null = await target
    .read()
    .catch(() => null);
  if (!found) {
    throw new ManualPublishCheckError(
      `No ${target.what} ${ptvId} in PTV (${ctx.environment}). Check the id; a draft may not be readable until it is published.`,
    );
  }
  const problems: string[] = [];
  if (target.expectedOrg && found.organizationId !== target.expectedOrg) {
    problems.push(
      target.what === 'organisation'
        ? `its parent is ${found.organizationId || 'none'}, not ${target.expectedOrg}`
        : `it belongs to organisation ${found.organizationId}, not ${target.expectedOrg}`,
    );
  }
  for (const [language, name] of Object.entries(changes.names ?? {})) {
    if (name && found.names[language] !== name) {
      problems.push(`its ${language} name is "${found.names[language] ?? ''}", not "${name}"`);
    }
  }
  if (problems.length > 0) {
    throw new ManualPublishCheckError(
      `The ${target.what} ${ptvId} does not match the proposal: ${problems.join('; ')}.`,
    );
  }
}

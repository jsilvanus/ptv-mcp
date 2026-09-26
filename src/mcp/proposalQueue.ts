import { resolveReadAdapter } from './toolContext.js';
import type { QualityReport, ServiceCheckContext } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { PtvContentId, Service } from '../ptv/domain.js';
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
  type StoredChanges,
} from '../proposals/proposalService.js';
import {
  FourEyesError,
  NotAuthorizedError,
  requireTenantRole,
  type FourEyesResolver,
  type MembershipRoleResolver,
} from './authorization.js';
import type { ToolContext } from './toolContext.js';
import { buildManualPublishSheet, type ManualPublishSheet } from './manualPublish.js';
import { queueKindProposal } from './proposalPipeline.js';
import {
  kindHandler,
  proposedServiceContext,
  type AppliedOutcome,
  type CurrentEntity,
  type ProposedEntity,
} from './proposalKinds.js';
import { prepareProposal, type ProposeChangesResult } from './proposeChanges.js';

export type ResolveProposalAction = 'approve_and_export' | 'approve_and_apply' | 'reject';

export interface QueuedProposeChangesResult extends ProposeChangesResult {
  proposalId: string;
  status: ProposalStatus;
  /** Automated content checks on the proposed service. */
  quality: QualityReport;
}

/**
 * Automated content checks on a proposal's `proposed` entity, by its kind's
 * handler (PROPOSAL_KINDS).
 */
export function proposedQuality(
  kind: ProposalKind,
  proposed: ProposedEntity | null,
  serviceContext: ServiceCheckContext = {},
): QualityReport | null {
  return proposed ? kindHandler(kind).quality(proposed, serviceContext) : null;
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
  changes: StoredChanges;
  queuedDiff: ProposeChangesResult['diff'];
  diff: ProposeChangesResult['diff'];
  /**
   * `null` for a service_create proposal (there is nothing to diff against)
   * and when the service or channel can no longer be read, e.g. after an
   * approved archive: PTV then returns 404 for it.
   */
  current: CurrentEntity | null;
  /** `null` when the service or channel can no longer be read (see `current`). */
  proposed: ProposedEntity | null;
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

/**
 * Records an action on a proposal (resourceType Proposal), under the
 * proposal's own correlation id.
 */
export function auditProposal(
  auditService: AuditService,
  ctx: Pick<ToolContext, 'tenantId' | 'actingUserId'>,
  proposal: Pick<ProposalRecord, 'id' | 'correlationId'>,
  action: string,
  result: string,
  afterState?: object,
): Promise<unknown> {
  return auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action,
    resourceType: 'Proposal',
    resourceId: proposal.id,
    ...(afterState ? { afterState } : {}),
    result,
    correlationId: proposal.correlationId,
  });
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
  const handler = kindHandler(proposal.kind);
  const serviceContext = await handler.qualityContext?.(registry, ctx, details.proposed);
  return {
    ...details,
    comments,
    reviewers,
    quality: proposedQuality(proposal.kind, details.proposed, serviceContext),
    ...manualPublishState(proposal, details),
  };
}

function manualPublishState(
  proposal: ProposalRecord,
  details: DiffDetails,
): Pick<ProposalDetails, 'manualPublish' | 'publishedInPtv'> {
  if (proposal.status !== 'approved') return { manualPublish: null, publishedInPtv: null };
  const handler = kindHandler(proposal.kind);
  const creating = handler.creates;
  return {
    manualPublish: buildManualPublishSheet({
      kind: proposal.kind,
      diff: creating ? proposal.queuedDiff : details.diff,
      ptvId: creating ? null : proposal.serviceId,
      ...handler.sheet.subject(handler.parse(proposal.changes), details),
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
  const archived = proposal.changes.publishingStatus === 'Archived';
  return archived ? true : null;
}

type DiffDetails = Omit<
  ProposalDetails,
  'comments' | 'reviewers' | 'quality' | 'manualPublish' | 'publishedInPtv'
>;

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
  const handler = kindHandler(proposal.kind);
  try {
    const { diff, current, proposed } = await handler.liveDiff(
      registry,
      { ...ctx, environment: proposal.environment },
      {
        targetId: proposal.serviceId,
        changes: handler.parse(proposal.changes),
        queuedDiff: proposal.queuedDiff,
      },
    );
    return { ...base, diff, current, proposed };
  } catch (err) {
    if (!handler.isNotFound(err)) throw err;
    // The target is gone (archived services and channels 404), but the
    // proposal record itself is still reviewable.
    return { ...base, diff: [], current: null, proposed: null };
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
  const { prepared, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService },
    ctx,
    {
      kind: 'service_update',
      input: changes,
      targetId: serviceId,
      resourceId: serviceId,
      prepare: () => prepareProposal(registry, ctx, serviceId, changes),
      changes: () => changes,
      // Validated when it is applied or exported (ptv_validate_changes).
      validate: false,
      qualityContext: (proposed) => proposedServiceContext(registry, ctx, proposed),
      correlationId,
      reviewItemId,
    },
  );
  return {
    ...prepared,
    correlationId: queued.correlationId,
    proposalId: queued.proposalId,
    status: queued.status,
    quality: queued.quality,
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
  await auditProposal(auditService, ctx, proposal, 'ReviewProposal', 'Viewed');
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

function requireCommentLength(text: string): void {
  if (text.length > MAX_COMMENT_LENGTH) {
    throw new InvalidCommentError(`Comment is longer than ${MAX_COMMENT_LENGTH} characters`);
  }
}

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
  requireCommentLength(text);
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  const comment = await proposalService.addComment(
    ctx.tenantId,
    proposal.id,
    ctx.actingUserId,
    text,
  );
  await auditProposal(auditService, ctx, proposal, 'CommentProposal', 'Commented', {
    commentId: comment.id,
    body: text,
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
  return reviewCandidatesOf(await listMembers(ctx.tenantId));
}

/** Members who can be named as reviewers: Contributor (Ehdottaja) or above, by name. */
export function reviewCandidatesOf(members: ReviewCandidate[]): ReviewCandidate[] {
  return members
    .filter((member) => ROLE_RANK[member.role] >= ROLE_RANK.contributor)
    .sort((a, b) => a.name.localeCompare(b.name, 'fi'));
}

/** The candidate `ref` (a user id or an email, any case) names, or undefined. */
export function findReviewCandidate(
  candidates: ReviewCandidate[],
  ref: string,
): ReviewCandidate | undefined {
  const id = ref.trim();
  const email = id.toLowerCase();
  return candidates.find(
    (candidate) => candidate.userId === id || candidate.email.toLowerCase() === email,
  );
}

/** Why `ref` can't be a reviewer, listing who can. */
export function notAReviewCandidateMessage(ref: string, candidates: ReviewCandidate[]): string {
  return `${ref} is not a Contributor (Ehdottaja) or above in this organisation. Possible reviewers: ${candidates
    .map((candidate) => `${candidate.name} <${candidate.email}>`)
    .join(', ')}`;
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
  const role = await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  requirePending(proposal);
  if (proposal.proposedByUserId !== ctx.actingUserId && ROLE_RANK[role] < ROLE_RANK.approver) {
    throw new NotAuthorizedError(ctx.tenantId, 'approver');
  }
  if (reviewers.length === 0) throw new InvalidReviewRequestError('Name at least one reviewer');
  const candidates = reviewCandidatesOf(await listMembers(ctx.tenantId));
  const userIds = new Set<string>();
  for (const reviewer of reviewers) {
    const match = findReviewCandidate(candidates, reviewer);
    if (!match) {
      throw new InvalidReviewRequestError(notAReviewCandidateMessage(reviewer, candidates));
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
  await auditProposal(auditService, ctx, proposal, 'RequestReview', 'Requested', {
    reviewerUserIds,
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
  if (text) requireCommentLength(text);
  const proposal = await proposalService.getById(ctx.tenantId, proposalId);
  requirePending(proposal);
  const reviewers = await proposalService.recordDecision(
    ctx.tenantId,
    proposal.id,
    ctx.actingUserId,
    decision,
    text,
  );
  await auditProposal(
    auditService,
    ctx,
    proposal,
    'SignOffProposal',
    decision === 'approved' ? 'Approved' : 'ChangesRequested',
    { decision, comment: text },
  );
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
    auditProposal(auditService, ctx, proposal, 'ResolveProposal', result, afterState);

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

  const handler = kindHandler(proposal.kind);
  const stored = () => ({
    targetId: proposal.serviceId,
    changes: handler.parse(proposal.changes),
    queuedDiff: proposal.queuedDiff,
    correlationId: proposal.correlationId,
  });
  const deps = { resolveRole, registry, auditService, validator };

  if (action === 'approve_and_export') {
    const afterState = await handler.approveForExport(deps, proposalCtx, stored());
    const approved = await proposalService.markResolved(
      ctx.tenantId,
      proposalId,
      'approved',
      ctx.actingUserId,
    );
    await record('ApprovedForManualPublish', afterState);
    return proposalDetails(registry, proposalService, approved, proposalCtx);
  }

  if (action !== 'approve_and_apply') throw new InvalidResolveActionError(action);

  let outcome: AppliedOutcome;
  try {
    outcome = await handler.apply(deps, proposalCtx, stored());
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
  if (kindHandler(proposal.kind).creates) {
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
  await auditProposal(
    auditService,
    ctx,
    proposal,
    'ConfirmManualPublish',
    'Published',
    createdId ? { ptvId: createdId } : undefined,
  );
  return proposalDetails(registry, proposalService, published, proposalCtx);
}

async function checkCreatedItem(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  proposal: ProposalRecord,
  ptvId: string,
): Promise<void> {
  const handler = kindHandler(proposal.kind);
  const target = handler.created;
  if (!target) throw new Error(`A ${proposal.kind} proposal does not create an item`);
  const adapter = await resolveReadAdapter(registry, ctx);
  // What to read back, and the organisation it must belong to: a service's
  // or channel's own organisation, a sub-organisation's parent.
  const expected = target.expected(handler.parse(proposal.changes));
  const found = await target.read(adapter, ptvId).catch(() => null);
  if (!found) {
    throw new ManualPublishCheckError(
      `No ${target.what} ${ptvId} in PTV (${ctx.environment}). Check the id; a draft may not be readable until it is published.`,
    );
  }
  const problems: string[] = [];
  if (expected.organizationId && found.organizationId !== expected.organizationId) {
    problems.push(
      target.what === 'organisation'
        ? `its parent is ${found.organizationId || 'none'}, not ${expected.organizationId}`
        : `it belongs to organisation ${found.organizationId}, not ${expected.organizationId}`,
    );
  }
  for (const [language, name] of Object.entries(expected.names)) {
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

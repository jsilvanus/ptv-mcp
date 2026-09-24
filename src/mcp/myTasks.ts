import { ROLE_RANK } from '../auth/rbac.js';
import type { ProposalReviewer, ProposalService } from '../proposals/proposalService.js';
import {
  listMyReviewItems,
  listReviewCampaigns,
  type ReviewCampaignSummary,
  type ReviewDeps,
  type ReviewItemWithProposals,
} from '../reviews/reviewCampaigns.js';
import { requireTenantRole, type FourEyesResolver } from './authorization.js';
import { toSummary, type ProposalSummary } from './proposalQueue.js';
import type { ToolContext } from './toolContext.js';

/**
 * Why a suggested change is still open:
 * - `waiting_for_reviewers`: required reviewers haven't all approved.
 * - `ready_to_resolve`: can be approved (export or apply) or rejected now.
 * - `needs_another_resolver`: your own proposal; four-eyes needs someone else.
 * - `approved_for_manual_publish`: approved + exported; enter it in PTV's
 *   own UI from its manual-publishing sheet, then close it with
 *   ptv_confirm_manual_publish (listed to Publishers and above).
 */
export type ChangeReadiness =
  | 'waiting_for_reviewers'
  | 'ready_to_resolve'
  | 'needs_another_resolver'
  | 'approved_for_manual_publish';

export interface ChangeToHandle extends ProposalSummary {
  readiness: ChangeReadiness;
  reviewers: Pick<ProposalReviewer, 'userName' | 'decision'>[];
}

export interface MyTasks {
  /** Open review items assigned to you. */
  reviewItems: ReviewItemWithProposals[];
  /** Pending proposals where you are a required reviewer and haven't signed off. */
  proposalsAwaitingMySignOff: ProposalSummary[];
  /**
   * Approver+: every suggested change in this environment that still needs
   * review, resolving or (Publisher+) publishing, oldest first.
   */
  changesToHandle: ChangeToHandle[];
  /** Publisher+: open review campaigns with their progress. */
  openCampaigns: ReviewCampaignSummary[];
  /** One line per non-empty list, for the assistant to tell the user. */
  summary: string[];
}

async function changesToHandle(
  proposalService: ProposalService,
  ctx: ToolContext,
  fourEyes: boolean,
  includeApproved: boolean,
): Promise<ChangeToHandle[]> {
  const [pending, approved] = await Promise.all([
    proposalService.listForTenant(ctx.tenantId, { status: 'pending' }),
    includeApproved
      ? proposalService.listForTenant(ctx.tenantId, { status: 'approved' })
      : Promise.resolve([]),
  ]);
  const result: ChangeToHandle[] = [];
  for (const proposal of pending.filter((p) => p.environment === ctx.environment)) {
    const reviewers = await proposalService.listReviewers(ctx.tenantId, proposal.id);
    const readiness: ChangeReadiness = reviewers.some((r) => r.decision !== 'approved')
      ? 'waiting_for_reviewers'
      : fourEyes && proposal.proposedByUserId === ctx.actingUserId
        ? 'needs_another_resolver'
        : 'ready_to_resolve';
    result.push({
      ...toSummary(proposal),
      readiness,
      reviewers: reviewers.map((r) => ({ userName: r.userName, decision: r.decision })),
    });
  }
  for (const proposal of approved.filter((p) => p.environment === ctx.environment)) {
    result.push({
      ...toSummary(proposal),
      readiness: 'approved_for_manual_publish',
      reviewers: [],
    });
  }
  return result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * `ptv_my_tasks`: everything waiting for the acting user in one call. MCP
 * has no user-facing push over this server's stateless transport, so the
 * assistant pulls this at the start of a session (see SERVER_INSTRUCTIONS)
 * and the web UI shows the same lists.
 */
export async function listMyTasks(
  deps: ReviewDeps,
  proposalService: ProposalService,
  requireFourEyes: FourEyesResolver,
  ctx: ToolContext,
): Promise<MyTasks> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const role = await deps.resolveRole(ctx.tenantId, ctx.actingUserId);
  const rank = role ? ROLE_RANK[role] : -1;
  const isApprover = rank >= ROLE_RANK.approver;
  const isPublisher = rank >= ROLE_RANK.publisher;
  const [reviewItems, awaiting, changes, campaigns] = await Promise.all([
    listMyReviewItems(deps, ctx),
    proposalService.listAwaitingReview(ctx.tenantId, ctx.actingUserId),
    isApprover
      ? requireFourEyes(ctx.tenantId).then((fourEyes) =>
          changesToHandle(proposalService, ctx, fourEyes, isPublisher),
        )
      : Promise.resolve([]),
    isPublisher ? listReviewCampaigns(deps, ctx) : Promise.resolve([]),
  ]);
  const openCampaigns = campaigns.filter((c) => c.status === 'open');

  const summary: string[] = [];
  if (reviewItems.length > 0) {
    summary.push(`${reviewItems.length} review item(s) assigned to you are waiting to be checked.`);
  }
  if (awaiting.length > 0) {
    summary.push(`${awaiting.length} proposal(s) are waiting for your sign-off.`);
  }
  const count = (readiness: ChangeReadiness) =>
    changes.filter((c) => c.readiness === readiness).length;
  if (count('ready_to_resolve') > 0) {
    summary.push(
      `${count('ready_to_resolve')} suggested change(s) are ready for you to approve or reject.`,
    );
  }
  if (count('waiting_for_reviewers') > 0) {
    summary.push(
      `${count('waiting_for_reviewers')} suggested change(s) are waiting for required reviewers.`,
    );
  }
  if (count('needs_another_resolver') > 0) {
    summary.push(
      `${count('needs_another_resolver')} of your own proposal(s) need another member to resolve them (four-eyes).`,
    );
  }
  if (count('approved_for_manual_publish') > 0) {
    summary.push(
      `${count('approved_for_manual_publish')} approved change(s) were exported and need publishing in PTV's own UI (ptv_get_proposal shows what to enter); confirm each with ptv_confirm_manual_publish once it is in PTV.`,
    );
  }
  for (const campaign of openCampaigns) {
    const { progress } = campaign;
    summary.push(
      `Campaign "${campaign.name}": ${progress.open} of ${progress.total} items still to check, ${progress.unassigned} unassigned, ${progress.changesProposed} sent with changes.`,
    );
  }
  if (summary.length === 0) summary.push('Nothing is waiting for you.');

  return {
    reviewItems,
    proposalsAwaitingMySignOff: awaiting.map(toSummary),
    changesToHandle: changes,
    openCampaigns,
    summary,
  };
}

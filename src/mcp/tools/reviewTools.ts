import { z } from 'zod';
import {
  assignReviewItems,
  attachProposalToReviewItem,
  closeReviewCampaign,
  completeReviewItem,
  getReviewCampaign,
  getReviewItem,
  listMyReviewItems,
  listReviewCampaigns,
  reopenReviewItem,
  startReviewCampaign,
} from '../../reviews/reviewCampaigns.js';
import { listMyTasks } from '../myTasks.js';
import { checkQuality } from '../qualityTools.js';
import { readToolContext, toolContext, type RegisterTool, type ToolDeps } from './shared.js';

/** The task inbox, automated quality checks and review campaigns. */
export function registerReviewTools(tool: RegisterTool, deps: ToolDeps): void {
  tool(
    'ptv_my_tasks',
    {
      description:
        "Everything waiting for you in this organisation and environment: review items assigned to you, proposals waiting for your sign-off, and for Approvers and above every suggested change that still needs review, resolving or (Publisher+) publishing in PTV, each with its readiness; Publishers also get open review campaigns' progress. Call it at the start of a session and tell the user the `summary` lines. Contributor role (Ehdottaja) or above.",
      inputSchema: {},
    },
    (_args, extra) =>
      listMyTasks(deps, deps.proposalService, deps.requireFourEyes, toolContext(extra)),
  );

  tool(
    'ptv_check_quality',
    {
      description:
        "Run the deterministic content checks (guides/content-quality.md's Q-* checks that can be decided from the data: contact details or opening hours in free text, missing or too long texts, summary repeating the name, classification limits, missing channels or languages, and Finnish style heuristics such as passive voice) on a published service or channel. Returns findings with severity error (breaks a DVV rule) or warning (heuristic, for a human to judge). The same checks run on every proposal and review item.",
      inputSchema: {
        kind: z.enum(['service', 'channel']),
        id: z.string(),
      },
    },
    (args, extra) => checkQuality(deps.registry, readToolContext(extra), args.kind, args.id),
  );

  tool(
    'ptv_review_start_campaign',
    {
      description:
        "Start a review campaign: a full check of an organisation's published PTV content in this environment. Every service, channel and organisation (sub-organisations included unless includeSubOrganisations is false) becomes a review item with its automated check findings. Needs the Publisher role (Julkaisija) or above. One open campaign per organisation. Next: assign items with ptv_review_assign.",
      inputSchema: {
        name: z.string().describe('e.g. "Syyskuun 2026 tarkistus"'),
        organizationId: z.string().uuid().describe('PTV organisation id'),
        dueDate: z.string().optional().describe('Target date, YYYY-MM-DD'),
        includeSubOrganisations: z.boolean().optional(),
      },
    },
    (args, extra) =>
      startReviewCampaign(deps, toolContext(extra), {
        name: args.name,
        organizationId: args.organizationId,
        ...(args.dueDate ? { dueDate: args.dueDate } : {}),
        ...(args.includeSubOrganisations !== undefined
          ? { includeSubOrganisations: args.includeSubOrganisations }
          : {}),
      }),
  );

  tool(
    'ptv_review_list_campaigns',
    {
      description:
        'List review campaigns with progress (items open, confirmed, changes proposed, unassigned). Contributor role (Ehdottaja) or above.',
      inputSchema: {},
    },
    (_args, extra) => listReviewCampaigns(deps, toolContext(extra)),
  );

  tool(
    'ptv_review_get_campaign',
    {
      description:
        'One review campaign with its items (reviewer, status, automated findings, linked proposals). assignedToMe: only your items. Contributor role (Ehdottaja) or above.',
      inputSchema: {
        campaignId: z.string().uuid(),
        assignedToMe: z.boolean().optional(),
        status: z.enum(['open', 'confirmed', 'changes_proposed']).optional(),
      },
    },
    (args, extra) =>
      getReviewCampaign(deps, toolContext(extra), args.campaignId, {
        ...(args.assignedToMe ? { assignedToMe: true } : {}),
        ...(args.status ? { status: args.status } : {}),
      }),
  );

  tool(
    'ptv_review_assign',
    {
      description:
        'Assign review items to a reviewer (email or user id; must be Contributor/Ehdottaja or above so they can propose changes). Give itemIds, or select by targetKind (organisation, service, channel) and/or organizationId; a selection only takes unassigned items unless reassign is true. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: {
        campaignId: z.string().uuid(),
        reviewer: z.string(),
        itemIds: z.array(z.string().uuid()).optional(),
        targetKind: z.enum(['organisation', 'service', 'channel']).optional(),
        organizationId: z.string().uuid().optional(),
        reassign: z.boolean().optional(),
      },
    },
    (args, extra) =>
      assignReviewItems(deps, toolContext(extra), {
        campaignId: args.campaignId,
        reviewer: args.reviewer,
        ...(args.itemIds ? { itemIds: args.itemIds } : {}),
        ...(args.targetKind ? { targetKind: args.targetKind } : {}),
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(args.reassign ? { reassign: true } : {}),
      }),
  );

  tool(
    'ptv_review_my_items',
    {
      description:
        'Your open review items in open campaigns, with automated findings and linked proposals. For each: read it with ptv_review_get_item, check that the content is up to date and the proper channels are linked, then either confirm it or propose changes (reviewItemId) and send it on with ptv_review_complete_item.',
      inputSchema: {},
    },
    (_args, extra) => listMyReviewItems(deps, toolContext(extra)),
  );

  tool(
    'ptv_review_get_item',
    {
      description:
        "One review item with the target's current PTV data, fresh automated checks and linked proposals. Contributor role (Ehdottaja) or above.",
      inputSchema: { itemId: z.string().uuid() },
    },
    (args, extra) => getReviewItem(deps, toolContext(extra), args.itemId),
  );

  tool(
    'ptv_review_complete_item',
    {
      description:
        "Record the reviewer's decision on a review item. confirmed: the content is up to date and the proper channels are linked, nothing to change (not allowed while linked proposals are pending). changes_proposed: sends the item to Publishers; needs at least one proposal made with this reviewItemId. Only the item's reviewer or a Publisher+. Call it only when the user has decided.",
      inputSchema: {
        itemId: z.string().uuid(),
        decision: z.enum(['confirmed', 'changes_proposed']),
        note: z.string().optional(),
      },
    },
    (args, extra) =>
      completeReviewItem(deps, toolContext(extra), args.itemId, args.decision, args.note),
  );

  tool(
    'ptv_review_reopen_item',
    {
      description:
        'Send a review item back to its reviewer (status open), e.g. when its proposals were rejected. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: { itemId: z.string().uuid(), note: z.string().optional() },
    },
    (args, extra) => reopenReviewItem(deps, toolContext(extra), args.itemId, args.note),
  );

  tool(
    'ptv_review_attach_proposal',
    {
      description:
        "Attach an existing pending proposal to a review campaign item, e.g. a draft a Publisher made for a reviewer to check. The proposal must fit the item (its own service or channel; a service change that edits connections fits a channel's item; a new service or channel fits any item). A finished item is reopened, and the item's reviewer becomes a required reviewer of the proposal, so it can't be approved before they sign off. Your own proposal, or any as a Publisher (Julkaisija) or above. Proposing with reviewItemId does the same in one step.",
      inputSchema: { itemId: z.string().uuid(), proposalId: z.string().uuid() },
    },
    (args, extra) =>
      attachProposalToReviewItem(deps, toolContext(extra), args.itemId, args.proposalId),
  );

  tool(
    'ptv_review_close_campaign',
    {
      description:
        'Close a review campaign; its items stay as the record. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: { campaignId: z.string().uuid() },
    },
    (args, extra) => closeReviewCampaign(deps, toolContext(extra), args.campaignId),
  );
}

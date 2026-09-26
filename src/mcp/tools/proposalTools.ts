import { z } from 'zod';
import type { ConnectionDetails, Organization, Service, ServiceChannel } from '../../ptv/domain.js';
import type { NewChannel, NewOrganization } from '../../ptv/adapter.js';
import {
  linkProposalToReviewItem,
  requireLinkableReviewItem,
} from '../../reviews/reviewCampaigns.js';
import { requireNoFourEyes } from '../authorization.js';
import { applyChanges, exportForManualPublish } from '../applyOrExport.js';
import { queueChannelProposal } from '../channelProposal.js';
import { queueConnectionProposal } from '../connectionProposal.js';
import { queueNewChannelProposal } from '../newChannelProposal.js';
import { queueNewServiceProposal } from '../newServiceProposal.js';
import {
  queueNewOrganizationProposal,
  queueOrganizationProposal,
} from '../organizationProposal.js';
import {
  commentOnProposal,
  confirmManualPublish,
  getProposal,
  listProposals,
  listReviewCandidates,
  MAX_COMMENT_LENGTH,
  queueProposal,
  requestReview,
  resolveProposal,
  signOffProposal,
} from '../proposalQueue.js';
import type { ToolContext } from '../toolContext.js';
import { validateChanges } from '../validateChanges.js';
import { toolContext, type RegisterTool, type ToolDeps } from './shared.js';

const correlationIdSchema = z.string().optional();

const reviewItemIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    'Review item this proposal answers (from ptv_review_my_items). Links the proposal to the review campaign; the item must be open and assigned to you.',
  );

const changesSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Partial<Service> — only the fields being changed. A key present but empty clears that field.',
  );

/** Proposing, reviewing and resolving changes, and the direct export/apply tools. */
export function registerProposalTools(tool: RegisterTool, deps: ToolDeps): void {
  const { resolveRole, registry, auditService, proposalService, validator, requireFourEyes } = deps;

  /**
   * Queues a proposal that may answer a review item: the item is checked
   * before queueing and linked to the queued proposal afterwards.
   */
  async function queueForReviewItem<R extends { proposalId: string }>(
    ctx: ToolContext,
    reviewItemId: string | undefined,
    proposal: Parameters<typeof requireLinkableReviewItem>[3],
    queue: () => Promise<R>,
  ): Promise<R> {
    const item = reviewItemId
      ? await requireLinkableReviewItem(deps, ctx, reviewItemId, proposal)
      : null;
    const result = await queue();
    if (item) {
      await linkProposalToReviewItem(
        deps,
        ctx,
        item,
        await proposalService.getById(ctx.tenantId, result.proposalId),
      );
    }
    return result;
  }

  tool(
    'ptv_propose_changes',
    {
      description:
        'Diff a proposed change against the current service. Never writes anything. Returns {serviceId, current, proposed, diff, correlationId} — pass correlationId to ptv_validate_changes/ptv_export_for_manual_publish/ptv_apply_changes to keep them in one audit trail.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: correlationIdSchema,
        reviewItemId: reviewItemIdSchema,
      },
    },
    (args, extra) => {
      const ctx = toolContext(extra);
      return queueForReviewItem(
        ctx,
        args.reviewItemId,
        {
          kind: 'service_update',
          targetId: args.serviceId,
          changes: args.changes as Record<string, unknown>,
        },
        () =>
          queueProposal(
            resolveRole,
            registry,
            auditService,
            proposalService,
            ctx,
            args.serviceId,
            args.changes as Partial<Service>,
            args.correlationId,
            args.reviewItemId,
          ),
      );
    },
  );

  tool(
    'ptv_propose_new_service',
    {
      description:
        'Queue a proposal to create a new PTV service. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (which also needs Publisher-level write access); PTV then assigns the id, recorded on the proposal. `service` is a Service without id: organizationId, serviceType (default Service), publishingStatus (Draft by default, or Published), names, summaries, descriptions (each keyed by language, e.g. {"fi": "..."}), languages, serviceClasses (at least one subclass, e.g. P25.6), ontologyTerms (KOKO URIs), targetGroups, optionally lifeEvents, industrialClasses (needs target groups KR2 + KR2.x), generalDescriptionId, serviceChannelIds. Classification entries need a `uri` (or `code` for industrial classes). The service area is copied from the organisation. Returns the validation result right away.',
      inputSchema: {
        service: z
          .record(z.string(), z.unknown())
          .describe('The new service: a Service without id (see the tool description).'),
        correlationId: correlationIdSchema,
        reviewItemId: reviewItemIdSchema,
      },
    },
    (args, extra) => {
      const ctx = toolContext(extra);
      return queueForReviewItem(ctx, args.reviewItemId, { kind: 'service_create' }, () =>
        queueNewServiceProposal(
          resolveRole,
          auditService,
          proposalService,
          validator,
          ctx,
          args.service as Partial<Service>,
          args.correlationId,
          args.reviewItemId,
        ),
      );
    },
  );

  tool(
    'ptv_propose_channel_changes',
    {
      description:
        'Diff a proposed change against a service channel and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). Writable fields by type (see ServiceChannel in the guides): all types names, summaries (max 150), descriptions, languages (languages it serves in), publishingStatus (Published, Draft for a never-published channel, or Archived), isVisibleForAll, serviceHours; EChannel urls, requiresAuthentication, requiresSignature, signatureQuantity, accessibility, supportPhones, supportEmails; WebPage urls, accessibility, supportPhones, supportEmails; Phone phoneNumbers (type Phone/Sms/Fax), urls, supportPhones, supportEmails; PrintableForm formFiles, formIdentifiers, deliveryAddresses, webPages, supportPhones, supportEmails; ServiceLocation addresses, phoneNumbers (Fax as type), emails, webPages. A field present in `changes` replaces all its values (every language, every list entry): read the channel first and send the full list. Phone numbers: number without the leading 0 plus prefixNumber +358, or isFinnishServiceNumber; times HH:mm; dates YYYY-MM-DD.',
      inputSchema: {
        channelId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            "Partial<ServiceChannel>: only the channel type's writable fields (see the description).",
          ),
        correlationId: correlationIdSchema,
        reviewItemId: reviewItemIdSchema,
      },
    },
    (args, extra) => {
      const ctx = toolContext(extra);
      return queueForReviewItem(
        ctx,
        args.reviewItemId,
        { kind: 'channel_update', targetId: args.channelId },
        () =>
          queueChannelProposal(
            resolveRole,
            registry,
            auditService,
            proposalService,
            ctx,
            args.channelId,
            args.changes as Partial<ServiceChannel>,
            args.correlationId,
            args.reviewItemId,
          ),
      );
    },
  );

  tool(
    'ptv_propose_connection_changes',
    {
      description:
        "Diff a change to a service–channel connection's extra info (liitoksen lisätiedot) and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). The service and channel must already be connected (connect them with ptv_propose_changes' serviceChannelIds). Use extra info only for what is specific to this service in this channel, e.g. the service's own hours or phone number at a shared service location. Writable fields: chargeType (Chargeable, FreeOfCharge, Other), descriptions and chargeDescriptions (keyed by language, max 500 characters each), serviceHours, emails, phoneNumbers (type Fax for fax numbers), webPages, addresses (postal only: Street, PostOfficeBox or Foreign). A field present in `changes` replaces all its values; an empty one clears it. Read the connection first (ptv_search_connections) and send the full list. Returns validation and automated quality checks right away.",
      inputSchema: {
        serviceId: z.string(),
        channelId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe('Partial connection extra info: only the fields being changed.'),
        correlationId: correlationIdSchema,
        reviewItemId: reviewItemIdSchema,
      },
    },
    (args, extra) => {
      const ctx = toolContext(extra);
      return queueForReviewItem(
        ctx,
        args.reviewItemId,
        {
          kind: 'connection_update',
          targetId: args.serviceId,
          changes: { channelId: args.channelId },
        },
        () =>
          queueConnectionProposal(
            resolveRole,
            registry,
            auditService,
            proposalService,
            ctx,
            args.serviceId,
            args.channelId,
            args.changes as Partial<ConnectionDetails>,
            args.correlationId,
            args.reviewItemId,
          ),
      );
    },
  );

  tool(
    'ptv_propose_organisation_changes',
    {
      description:
        'Diff a change to an organisation or sub-organisation and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). Writable fields: names, alternativeNames (an unofficial name customers use) and alternativeNameShownIn (languages that show it instead of the official name), summaries (max 150, not a copy of the name), descriptions (max 2500, what the organisation is and does for its customers, no contact details), businessCode (Y-tunnus 1234567-8), publishingStatus (Published, or Archived to archive a sub-organisation that no longer exists), emails, phoneNumbers, webPages, addresses (one Visiting address for the main office, others Postal; Street, PostOfficeBox, Foreign or Other). Texts are keyed by language, e.g. {"fi": "..."}, and every language version needs a name, a summary and a description. A field present in `changes` replaces all its values; read the organisation first (ptv_get_organisation). The type, area and parent are changed in PTV\'s UI.',
      inputSchema: {
        organizationId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe('Partial<Organization>: only the fields being changed (see the description).'),
        correlationId: correlationIdSchema,
      },
    },
    (args, extra) =>
      queueOrganizationProposal(
        resolveRole,
        registry,
        auditService,
        proposalService,
        toolContext(extra),
        args.organizationId,
        args.changes as Partial<Organization>,
        args.correlationId,
      ),
  );

  tool(
    'ptv_propose_new_organisation',
    {
      description:
        "Queue a proposal to create a sub-organisation (alaorganisaatio) under an existing organisation. Needs the Contributor role (Ehdottaja); nothing is written until an Approver+ resolves it with approve_and_apply (Publisher-level write access), and PTV then assigns the id. Create one only when customers benefit from seeing it as the responsible organisation, or reporting needs it; at most five levels below the main organisation. `organization` needs parentOrganizationId, names, summaries and descriptions for every language the sub-organisation's services will use (keyed by language), and businessCode (its own Y-tunnus, or the parent's if it shares it; check which). organizationType, area and municipality are copied from the parent unless given. Optional: alternativeNames, alternativeNameShownIn, emails, phoneNumbers, webPages, addresses (see ptv_propose_organisation_changes). Starts as Draft unless publishingStatus is Published. Returns validation and quality checks right away.",
      inputSchema: {
        organization: z
          .record(z.string(), z.unknown())
          .describe('The new sub-organisation (see the description).'),
        correlationId: correlationIdSchema,
      },
    },
    (args, extra) =>
      queueNewOrganizationProposal(
        resolveRole,
        registry,
        auditService,
        proposalService,
        toolContext(extra),
        args.organization as Partial<NewOrganization>,
        args.correlationId,
      ),
  );

  tool(
    'ptv_propose_new_channel',
    {
      description:
        'Queue a proposal to create a new service channel. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (Publisher-level write access); PTV then assigns the id, recorded on the proposal. `channel` needs channelType (EChannel, WebPage, Phone, PrintableForm, ServiceLocation) and organizationId, then names, summaries and descriptions (keyed by language, e.g. {"fi": "..."}) for every language version, languages (the languages it serves customers in), and the type\'s fields (see ptv_propose_channel_changes): EChannel and WebPage need urls for every language version; Phone needs phoneNumbers; ServiceLocation needs a street address in addresses; PrintableForm needs formFiles. Optional serviceIds connects it to existing services. Starts as Draft and shared (isVisibleForAll) unless set. Returns validation and automated quality checks right away. Do not describe another organisation\'s channel: connect their shared channel instead.',
      inputSchema: {
        channel: z
          .record(z.string(), z.unknown())
          .describe('The new channel: a ServiceChannel without id, plus optional serviceIds.'),
        correlationId: correlationIdSchema,
        reviewItemId: reviewItemIdSchema,
      },
    },
    (args, extra) => {
      const ctx = toolContext(extra);
      return queueForReviewItem(ctx, args.reviewItemId, { kind: 'channel_create' }, () =>
        queueNewChannelProposal(
          resolveRole,
          auditService,
          proposalService,
          ctx,
          args.channel as Partial<NewChannel>,
          args.correlationId,
          args.reviewItemId,
        ),
      );
    },
  );

  tool(
    'ptv_list_proposals',
    {
      description:
        'List queued proposals for a tenant (kind: service_update, service_create or channel_update). waitingForMe: true lists only pending proposals waiting for your sign-off as a required reviewer. Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).optional(),
        waitingForMe: z.boolean().optional(),
      },
    },
    (args, extra) =>
      listProposals(
        resolveRole,
        proposalService,
        toolContext(extra),
        args.status,
        args.waitingForMe ?? false,
      ),
  );

  tool(
    'ptv_get_proposal',
    {
      description:
        'Read one proposal and re-diff it against the current service state for review. Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        proposalId: z.string(),
      },
    },
    (args, extra) =>
      getProposal(
        resolveRole,
        registry,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
      ),
  );

  tool(
    'ptv_comment_proposal',
    {
      description:
        'Add a comment to a proposal, e.g. a review note or the reason for a change. Requires the Contributor role (Ehdottaja) or above. Comments show up in ptv_get_proposal and the web review page.',
      inputSchema: {
        proposalId: z.string(),
        comment: z.string().min(1).max(MAX_COMMENT_LENGTH),
      },
    },
    (args, extra) =>
      commentOnProposal(
        resolveRole,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
        args.comment,
      ),
  );

  tool(
    'ptv_request_review',
    {
      description:
        'Name required reviewers (emails or user ids of Contributor+ members) for a pending proposal. Approving then waits until every reviewer has signed off with ptv_sign_off_proposal. The proposer or an Approver (Hyväksyjä) may ask. Without reviewers, lists the possible ones.',
      inputSchema: {
        proposalId: z.string(),
        reviewers: z.array(z.string().min(1)).max(20).optional(),
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      if (!args.reviewers || args.reviewers.length === 0) {
        return {
          possibleReviewers: await listReviewCandidates(resolveRole, deps.listMembers, ctx),
        };
      }
      return await requestReview(
        resolveRole,
        deps.listMembers,
        proposalService,
        auditService,
        ctx,
        args.proposalId,
        args.reviewers,
      );
    },
  );

  tool(
    'ptv_sign_off_proposal',
    {
      description:
        'Sign off a pending proposal you were asked to review: approved (Hyväksyn) or changes_requested (Pyydän muutoksia), with an optional comment. You can change your sign-off until the proposal is resolved.',
      inputSchema: {
        proposalId: z.string(),
        decision: z.enum(['approved', 'changes_requested']),
        comment: z.string().max(MAX_COMMENT_LENGTH).optional(),
      },
    },
    (args, extra) =>
      signOffProposal(
        resolveRole,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
        args.decision,
        args.comment,
      ),
  );

  tool(
    'ptv_resolve_proposal',
    {
      description:
        "Resolve one proposal as approve_and_export, approve_and_apply, or reject. Requires the Approver role (Hyväksyjä) or above; apply also requires the Publisher role (Julkaisija). With four-eyes on (the default), you cannot approve a proposal you created, only reject it. Approving also waits for every required reviewer to sign off. approve_and_export writes nothing: the result's manualPublish sheet lists every field to enter in PTV's own UI (Finnish labels, PTV formats) and the steps; after entering it, close it with ptv_confirm_manual_publish.",
      inputSchema: {
        proposalId: z.string(),
        action: z.enum(['approve_and_export', 'approve_and_apply', 'reject']),
      },
    },
    (args, extra) =>
      resolveProposal(
        resolveRole,
        registry,
        proposalService,
        auditService,
        validator,
        toolContext(extra),
        args.proposalId,
        args.action,
        requireFourEyes,
      ),
  );

  tool(
    'ptv_confirm_manual_publish',
    {
      description:
        "Close an approved (approve_and_export) proposal after a person has entered it in PTV's own UI. The MCP checks PTV first: an update must have nothing left to differ; a new service or channel needs ptvId (the id PTV gave it) and must belong to the organisation and carry the proposed names. Then the proposal becomes applied (the id is recorded for new items). If PTV still differs, the error lists the fields; ptv_get_proposal shows what is left in its manualPublish sheet. Approver role (Hyväksyjä) or above.",
      inputSchema: {
        proposalId: z.string(),
        ptvId: z
          .string()
          .optional()
          .describe('New services and channels only: the id PTV gave the created item.'),
      },
    },
    (args, extra) =>
      confirmManualPublish(
        resolveRole,
        registry,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
        args.ptvId,
      ),
  );

  tool(
    'ptv_validate_changes',
    {
      description:
        'Validate an already-merged proposed service (the "proposed" object ptv_propose_changes returned) against PTV write rules.',
      inputSchema: {
        proposed: z.record(z.string(), z.unknown()),
        correlationId: correlationIdSchema,
      },
    },
    (args, extra) =>
      validateChanges(
        auditService,
        validator,
        toolContext(extra),
        args.proposed as unknown as Service,
        args.correlationId,
      ),
  );

  tool(
    'ptv_export_for_manual_publish',
    {
      description:
        "Render an approved proposal into a per-language preview for manual copy into PTV's own admin UI, and record it as ReadyForManualPublish. Refused when the organisation requires four-eyes review (the default): use ptv_propose_changes instead.",
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: correlationIdSchema,
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      await requireNoFourEyes(requireFourEyes, ctx.tenantId);
      return await exportForManualPublish(
        resolveRole,
        registry,
        auditService,
        ctx,
        args.serviceId,
        args.changes as Partial<Service>,
        args.correlationId,
      );
    },
  );

  tool(
    'ptv_apply_changes',
    {
      description:
        'Validate and write a proposed change directly to PTV via a write-capable adapter for this tenant/environment. Requires Publisher role and an active PTV connection. Refused when the organisation requires four-eyes review (the default): use ptv_propose_changes instead.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: correlationIdSchema,
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      await requireNoFourEyes(requireFourEyes, ctx.tenantId);
      return await applyChanges(
        resolveRole,
        registry,
        auditService,
        validator,
        ctx,
        args.serviceId,
        args.changes as Partial<Service>,
        args.correlationId,
      );
    },
  );
}

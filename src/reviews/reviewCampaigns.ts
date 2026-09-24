import { randomUUID } from 'node:crypto';
import { ROLE_RANK, type MembershipRole } from '../auth/rbac.js';
import type { AuditService } from '../audit/auditService.js';
import {
  NotAuthorizedError,
  requireTenantRole,
  type MembershipRoleResolver,
} from '../mcp/authorization.js';
import type { MemberLister, ReviewCandidate } from '../mcp/proposalQueue.js';
import type { ToolContext } from '../mcp/toolContext.js';
import type { PtvAdapter } from '../ptv/adapter.js';
import type {
  LocalizedText,
  Organization,
  PaginatedResult,
  SearchParams,
  Service,
  ServiceChannel,
} from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalKind } from '../proposals/proposalService.js';
import { checkChannel, checkService, type QualityReport } from '../quality/contentChecks.js';
import type {
  CampaignProgress,
  LinkedProposal,
  NewReviewItem,
  ReviewCampaignRecord,
  ReviewItemView,
  ReviewService,
  ReviewTargetKind,
} from './reviewService.js';

/**
 * Review campaigns (docs/review-campaigns-plan.md): a Publisher+ starts a
 * full check of an organisation's published PTV content and assigns every
 * service, channel and organisation to a reviewer (Contributor+). The
 * reviewer confirms the item is up to date with the right channels linked,
 * or proposes changes linked to the item and sends it on; Publishers then
 * resolve those proposals in the normal queue. Every step is audited under
 * the campaign's correlation id.
 */

export class ReviewCampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewCampaignError';
  }
}

/** Longest review note accepted, like proposal comments. */
export const MAX_NOTE_LENGTH = 4000;
/** Safety cap on items per campaign; PTV organisations rarely have more. */
export const MAX_CAMPAIGN_ITEMS = 5000;
const PAGE_SIZE = 200;

export interface ReviewCampaignSummary extends ReviewCampaignRecord {
  createdByName: string | null;
  progress: CampaignProgress;
}

export interface ReviewItemWithProposals extends ReviewItemView {
  proposals: LinkedProposal[];
}

export interface ReviewCampaignDetails extends ReviewCampaignSummary {
  items: ReviewItemWithProposals[];
}

export interface ReviewItemDetails extends ReviewItemWithProposals {
  campaign: ReviewCampaignRecord;
  /** The target as PTV has it now; null if it can no longer be read. */
  current: Service | ServiceChannel | Organization | null;
  /** Automated checks on `current`, run now. */
  quality: QualityReport | null;
}

export interface ReviewDeps {
  resolveRole: MembershipRoleResolver;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
  reviewService: ReviewService;
  listMembers: MemberLister;
}

function displayName(names: LocalizedText): string {
  return names.fi ?? names.sv ?? names.en ?? Object.values(names).find(Boolean) ?? '(nimetön)';
}

async function readAdapter(registry: PtvAdapterRegistry, ctx: ToolContext): Promise<PtvAdapter> {
  return registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.readApiVersion ?? ctx.apiVersion ?? 'v11',
    operation: 'read',
    actingUserId: ctx.actingUserId,
  });
}

async function fetchAll<T>(
  search: (params: SearchParams) => Promise<PaginatedResult<T>>,
  organizationId: string,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await search({ organizationId, page, pageSize: PAGE_SIZE });
    items.push(...result.items);
    if (
      result.items.length < PAGE_SIZE ||
      items.length >= result.totalCount ||
      items.length >= MAX_CAMPAIGN_ITEMS
    ) {
      return items;
    }
  }
}

/** The organisation and, optionally, every organisation below it in the tenant's catalogue. */
async function organisationsToReview(
  adapter: PtvAdapter,
  organizationId: string,
  includeSubOrganisations: boolean,
): Promise<Organization[]> {
  const root = await adapter.getOrganisation(organizationId);
  if (!root) throw new ReviewCampaignError(`PTV organisation not found: ${organizationId}`);
  if (!includeSubOrganisations) return [root];
  // The whole catalogue: searchOrganisations has no parent filter, and v11
  // serves it from the tenant's cached copy.
  const catalogue = await adapter
    .searchOrganisations({ page: 1, pageSize: 100000 })
    .then((result) => result.items)
    .catch(() => [] as Organization[]);
  const result = [root];
  const seen = new Set([root.id]);
  for (let i = 0; i < result.length; i += 1) {
    const parentId = result[i]!.id;
    for (const org of catalogue) {
      if (org.parentOrganizationId === parentId && !seen.has(org.id)) {
        seen.add(org.id);
        result.push(org);
      }
    }
  }
  return result;
}

async function collectItems(
  adapter: PtvAdapter,
  organisations: Organization[],
): Promise<NewReviewItem[]> {
  const items: NewReviewItem[] = [];
  const services: Service[] = [];
  const channels: ServiceChannel[] = [];
  for (const org of organisations) {
    items.push({
      targetKind: 'organisation',
      targetId: org.id,
      targetName: displayName(org.names),
      organizationId: org.id,
      findings: [],
    });
    services.push(...(await fetchAll((p) => adapter.searchServices(p), org.id)));
    channels.push(...(await fetchAll((p) => adapter.searchChannels(p), org.id)));
  }

  const orgNames = new Map(organisations.map((org) => [org.id, org.names]));
  const connected = new Map<string, number>();
  for (const service of services) {
    for (const channelId of service.serviceChannelIds) {
      connected.set(channelId, (connected.get(channelId) ?? 0) + 1);
    }
    const organisationNames = orgNames.get(service.organizationId);
    items.push({
      targetKind: 'service',
      targetId: service.id,
      targetName: displayName(service.names),
      organizationId: service.organizationId,
      findings: checkService(service, organisationNames ? { organisationNames } : {}).findings,
    });
  }
  for (const channel of channels) {
    let count = connected.get(channel.id) ?? 0;
    if (count === 0) {
      // Connected only to other organisations' services? Ask PTV before flagging it.
      count = await adapter
        .getConnectionsFor(channel.id)
        .then((connections) => connections.length)
        .catch(() => 0);
    }
    items.push({
      targetKind: 'channel',
      targetId: channel.id,
      targetName: displayName(channel.names),
      channelType: channel.channelType,
      organizationId: channel.organizationId,
      findings: checkChannel(channel, { connectedServiceCount: count }).findings,
    });
  }
  return items.slice(0, MAX_CAMPAIGN_ITEMS);
}

async function audit(
  deps: ReviewDeps,
  ctx: ToolContext,
  action: string,
  resourceType: 'ReviewCampaign' | 'ReviewItem',
  resourceId: string,
  correlationId: string,
  result: string,
  afterState?: Record<string, unknown>,
): Promise<void> {
  await deps.auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action,
    resourceType,
    resourceId,
    result,
    correlationId,
    ...(afterState ? { afterState } : {}),
  });
}

function checkNote(note: string | undefined): string | null {
  const text = note?.trim() || null;
  if (text && text.length > MAX_NOTE_LENGTH) {
    throw new ReviewCampaignError(`Note is longer than ${MAX_NOTE_LENGTH} characters`);
  }
  return text;
}

async function hasRole(
  deps: ReviewDeps,
  ctx: ToolContext,
  minRole: MembershipRole,
): Promise<boolean> {
  const role = await deps.resolveRole(ctx.tenantId, ctx.actingUserId);
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[minRole];
}

function requireOpen(campaign: ReviewCampaignRecord): void {
  if (campaign.status !== 'open') {
    throw new ReviewCampaignError(`Review campaign "${campaign.name}" is closed`);
  }
}

async function summaries(
  deps: ReviewDeps,
  tenantId: string,
  campaigns: ReviewCampaignRecord[],
): Promise<ReviewCampaignSummary[]> {
  const [progress, names] = await Promise.all([
    deps.reviewService.progress(
      tenantId,
      campaigns.map((c) => c.id),
    ),
    deps.reviewService.userNames([...new Set(campaigns.map((c) => c.createdByUserId))]),
  ]);
  return campaigns.map((campaign) => ({
    ...campaign,
    createdByName: names.get(campaign.createdByUserId) ?? null,
    progress: progress.get(campaign.id) ?? {
      total: 0,
      open: 0,
      confirmed: 0,
      changesProposed: 0,
      unassigned: 0,
    },
  }));
}

async function withProposals(
  deps: ReviewDeps,
  tenantId: string,
  items: ReviewItemView[],
): Promise<ReviewItemWithProposals[]> {
  const linked = await deps.reviewService.linkedProposals(
    tenantId,
    items.map((item) => item.id),
  );
  return items.map((item) => ({
    ...item,
    proposals: linked.filter((proposal) => proposal.reviewItemId === item.id),
  }));
}

/**
 * Starts a campaign over the organisation's published services and
 * channels (and its sub-organisations'), running the automated checks on
 * each. Publisher+. One open campaign per organisation and environment.
 */
export async function startReviewCampaign(
  deps: ReviewDeps,
  ctx: ToolContext,
  input: {
    name: string;
    organizationId: string;
    dueDate?: string;
    includeSubOrganisations?: boolean;
  },
): Promise<ReviewCampaignSummary> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'publisher');
  const name = input.name.trim();
  if (!name) throw new ReviewCampaignError('Give the campaign a name');
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw new ReviewCampaignError('dueDate must be a date like 2026-12-31');
  }
  const existing = await deps.reviewService.findOpenCampaign(
    ctx.tenantId,
    ctx.environment,
    input.organizationId,
  );
  if (existing) {
    throw new ReviewCampaignError(
      `Campaign "${existing.name}" (${existing.id}) is still open for this organisation; close it first.`,
    );
  }
  const adapter = await readAdapter(deps.registry, ctx);
  const organisations = await organisationsToReview(
    adapter,
    input.organizationId,
    input.includeSubOrganisations ?? true,
  );
  const items = await collectItems(adapter, organisations);
  const correlationId = randomUUID();
  const campaign = await deps.reviewService.createCampaign({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    name,
    organizationId: input.organizationId,
    dueDate: input.dueDate ?? null,
    createdByUserId: ctx.actingUserId,
    correlationId,
    items,
  });
  await audit(
    deps,
    ctx,
    'StartReviewCampaign',
    'ReviewCampaign',
    campaign.id,
    correlationId,
    'Started',
    {
      name,
      organizationId: input.organizationId,
      organisations: organisations.map((org) => org.id),
      items: items.length,
    },
  );
  const [summary] = await summaries(deps, ctx.tenantId, [campaign]);
  return summary!;
}

/** Campaigns of the tenant, newest first, with progress. Contributor+. */
export async function listReviewCampaigns(
  deps: ReviewDeps,
  ctx: ToolContext,
): Promise<ReviewCampaignSummary[]> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  return summaries(deps, ctx.tenantId, await deps.reviewService.listCampaigns(ctx.tenantId));
}

/** One campaign with its items and their linked proposals. Contributor+. */
export async function getReviewCampaign(
  deps: ReviewDeps,
  ctx: ToolContext,
  campaignId: string,
  filter: { assignedToMe?: boolean; status?: ReviewItemView['status'] } = {},
): Promise<ReviewCampaignDetails> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, campaignId);
  const items = await deps.reviewService.listItems(ctx.tenantId, campaignId, {
    ...(filter.assignedToMe ? { assigneeUserId: ctx.actingUserId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
  });
  const [summary] = await summaries(deps, ctx.tenantId, [campaign]);
  return { ...summary!, items: await withProposals(deps, ctx.tenantId, items) };
}

/** Open items assigned to the acting user in open campaigns. Contributor+. */
export async function listMyReviewItems(
  deps: ReviewDeps,
  ctx: ToolContext,
): Promise<ReviewItemWithProposals[]> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const items = await deps.reviewService.listOpenItemsFor(ctx.tenantId, ctx.actingUserId);
  return withProposals(deps, ctx.tenantId, items);
}

/**
 * Assigns campaign items to a reviewer (by email or user id), who must be a
 * Contributor+ so they can propose changes. Either name the items, or
 * select by kind / organisation (only unassigned items unless
 * `reassign`). Publisher+.
 */
export async function assignReviewItems(
  deps: ReviewDeps,
  ctx: ToolContext,
  input: {
    campaignId: string;
    reviewer: string;
    itemIds?: string[];
    targetKind?: ReviewTargetKind;
    organizationId?: string;
    reassign?: boolean;
  },
): Promise<{ assigned: number; reviewer: ReviewCandidate }> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'publisher');
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, input.campaignId);
  requireOpen(campaign);
  const key = input.reviewer.trim().toLowerCase();
  const candidates = (await deps.listMembers(ctx.tenantId)).filter(
    (member) => ROLE_RANK[member.role] >= ROLE_RANK.contributor,
  );
  const reviewer = candidates.find(
    (member) => member.userId === input.reviewer.trim() || member.email.toLowerCase() === key,
  );
  if (!reviewer) {
    throw new ReviewCampaignError(
      `${input.reviewer} is not a Contributor (Ehdottaja) or above in this organisation. Possible reviewers: ${candidates
        .map((member) => `${member.name} <${member.email}>`)
        .join(', ')}`,
    );
  }
  const itemIds = input.itemIds?.length ? input.itemIds : undefined;
  const assigned = await deps.reviewService.assignItems(
    ctx.tenantId,
    campaign.id,
    reviewer.userId,
    {
      ...(itemIds ? { itemIds } : {}),
      ...(input.targetKind ? { targetKind: input.targetKind } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      onlyUnassigned: !itemIds && !input.reassign,
    },
  );
  await audit(
    deps,
    ctx,
    'AssignReviewItems',
    'ReviewCampaign',
    campaign.id,
    campaign.correlationId,
    'Assigned',
    {
      reviewerUserId: reviewer.userId,
      assigned,
      ...(itemIds ? { itemIds } : {}),
      ...(input.targetKind ? { targetKind: input.targetKind } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
  );
  return { assigned, reviewer };
}

async function readTarget(
  adapter: PtvAdapter,
  item: ReviewItemView,
): Promise<Service | ServiceChannel | Organization | null> {
  if (item.targetKind === 'service') return adapter.getService(item.targetId);
  if (item.targetKind === 'channel') return adapter.getChannel(item.targetId);
  return adapter.getOrganisation(item.targetId);
}

/** One item with its current PTV data and fresh automated checks. Contributor+. */
export async function getReviewItem(
  deps: ReviewDeps,
  ctx: ToolContext,
  itemId: string,
): Promise<ReviewItemDetails> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  const item = await deps.reviewService.getItem(ctx.tenantId, itemId);
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, item.campaignId);
  const adapter = await readAdapter(deps.registry, { ...ctx, environment: campaign.environment });
  const current = await readTarget(adapter, item).catch(() => null);
  let quality: QualityReport | null = null;
  if (current && item.targetKind === 'service') {
    const service = current as Service;
    const org = await adapter.getOrganisation(service.organizationId).catch(() => null);
    quality = checkService(service, org ? { organisationNames: org.names } : {});
  } else if (current && item.targetKind === 'channel') {
    const connections = await adapter.getConnectionsFor(item.targetId).catch(() => undefined);
    quality = checkChannel(
      current as ServiceChannel,
      connections ? { connectedServiceCount: connections.length } : {},
    );
  }
  const [withLinks] = await withProposals(deps, ctx.tenantId, [item]);
  return { ...withLinks!, campaign, current, quality };
}

async function requireReviewerOf(
  deps: ReviewDeps,
  ctx: ToolContext,
  item: ReviewItemView,
): Promise<void> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  if (item.assigneeUserId === ctx.actingUserId) return;
  if (await hasRole(deps, ctx, 'publisher')) return;
  throw new NotAuthorizedError(ctx.tenantId, 'publisher');
}

/**
 * Checks that a new proposal may be linked to a review item: the campaign
 * is open and in the same environment, the item is still open, the actor is
 * its reviewer (or a Publisher+), and the proposal targets the item's
 * service or channel (a new service may come from any item).
 */
export async function requireLinkableReviewItem(
  deps: ReviewDeps,
  ctx: ToolContext,
  itemId: string,
  proposal: { kind: ProposalKind; targetId?: string },
): Promise<ReviewItemView> {
  const item = await deps.reviewService.getItem(ctx.tenantId, itemId);
  await requireReviewerOf(deps, ctx, item);
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, item.campaignId);
  requireOpen(campaign);
  if (campaign.environment !== ctx.environment) {
    throw new ReviewCampaignError(
      `Review item belongs to the ${campaign.environment} environment; this connection uses ${ctx.environment}.`,
    );
  }
  if (item.status !== 'open') {
    throw new ReviewCampaignError(
      `Review item "${item.targetName}" is already ${item.status}; ask a Publisher to reopen it.`,
    );
  }
  const expectedKind =
    proposal.kind === 'service_update'
      ? 'service'
      : proposal.kind === 'channel_update'
        ? 'channel'
        : null;
  if (expectedKind && (item.targetKind !== expectedKind || item.targetId !== proposal.targetId)) {
    throw new ReviewCampaignError(
      `Review item "${item.targetName}" is the ${item.targetKind} ${item.targetId}; this proposal targets another ${expectedKind}.`,
    );
  }
  return item;
}

/**
 * The reviewer's decision on an item: `confirmed` (up to date, proper
 * channels linked, nothing to change) or `changes_proposed` (sent to
 * Publishers; needs at least one linked proposal). The item's reviewer or a
 * Publisher+.
 */
export async function completeReviewItem(
  deps: ReviewDeps,
  ctx: ToolContext,
  itemId: string,
  decision: 'confirmed' | 'changes_proposed',
  note?: string,
): Promise<ReviewItemWithProposals> {
  const item = await deps.reviewService.getItem(ctx.tenantId, itemId);
  await requireReviewerOf(deps, ctx, item);
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, item.campaignId);
  requireOpen(campaign);
  const text = checkNote(note);
  const [withLinks] = await withProposals(deps, ctx.tenantId, [item]);
  const pending = withLinks!.proposals.filter((proposal) => proposal.status === 'pending');
  if (decision === 'changes_proposed' && withLinks!.proposals.length === 0) {
    throw new ReviewCampaignError(
      'No proposals are linked to this item. Propose the changes with reviewItemId first, or confirm the item if nothing needs changing.',
    );
  }
  if (decision === 'confirmed' && pending.length > 0) {
    throw new ReviewCampaignError(
      `${pending.length} linked proposal(s) are still pending; send the item as changes_proposed, or have the proposals rejected first.`,
    );
  }
  const updated = await deps.reviewService.setItemStatus(
    ctx.tenantId,
    item.id,
    decision,
    ctx.actingUserId,
    text,
  );
  await audit(
    deps,
    ctx,
    'CompleteReviewItem',
    'ReviewItem',
    item.id,
    campaign.correlationId,
    decision === 'confirmed' ? 'Confirmed' : 'ChangesProposed',
    {
      campaignId: campaign.id,
      targetKind: item.targetKind,
      targetId: item.targetId,
      note: text,
      proposals: withLinks!.proposals.map((proposal) => proposal.id),
    },
  );
  const [result] = await withProposals(deps, ctx.tenantId, [updated]);
  return result!;
}

/** Sends an item back to its reviewer (status `open`), with a note. Publisher+. */
export async function reopenReviewItem(
  deps: ReviewDeps,
  ctx: ToolContext,
  itemId: string,
  note?: string,
): Promise<ReviewItemWithProposals> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'publisher');
  const item = await deps.reviewService.getItem(ctx.tenantId, itemId);
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, item.campaignId);
  requireOpen(campaign);
  const text = checkNote(note);
  const updated = await deps.reviewService.setItemStatus(ctx.tenantId, item.id, 'open', null, text);
  await audit(
    deps,
    ctx,
    'ReopenReviewItem',
    'ReviewItem',
    item.id,
    campaign.correlationId,
    'Reopened',
    {
      campaignId: campaign.id,
      note: text,
    },
  );
  const [result] = await withProposals(deps, ctx.tenantId, [updated]);
  return result!;
}

/** Closes a campaign; items left open stay as they are for the record. Publisher+. */
export async function closeReviewCampaign(
  deps: ReviewDeps,
  ctx: ToolContext,
  campaignId: string,
): Promise<ReviewCampaignSummary> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'publisher');
  const campaign = await deps.reviewService.getCampaign(ctx.tenantId, campaignId);
  requireOpen(campaign);
  const closed = await deps.reviewService.closeCampaign(ctx.tenantId, campaignId);
  const [summary] = await summaries(deps, ctx.tenantId, [closed]);
  await audit(
    deps,
    ctx,
    'CloseReviewCampaign',
    'ReviewCampaign',
    campaignId,
    campaign.correlationId,
    'Closed',
    {
      progress: summary!.progress,
    },
  );
  return summary!;
}

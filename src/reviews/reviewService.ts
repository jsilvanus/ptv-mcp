import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import {
  proposals,
  reviewCampaigns,
  reviewCampaignStatusEnum,
  reviewItems,
  reviewItemStatusEnum,
  reviewTargetKindEnum,
  users,
} from '../db/schema/index.js';
import type { QualityFinding } from '../quality/contentChecks.js';
import type { ProposalKind, ProposalStatus } from '../proposals/proposalService.js';

export type ReviewCampaignStatus = (typeof reviewCampaignStatusEnum.enumValues)[number];
export type ReviewItemStatus = (typeof reviewItemStatusEnum.enumValues)[number];
export type ReviewTargetKind = (typeof reviewTargetKindEnum.enumValues)[number];

export interface ReviewCampaignRecord {
  id: string;
  tenantId: string;
  environment: 'test' | 'production';
  name: string;
  organizationId: string;
  status: ReviewCampaignStatus;
  dueDate: string | null;
  createdByUserId: string;
  correlationId: string;
  createdAt: Date;
  closedAt: Date | null;
}

export interface ReviewItemRecord {
  id: string;
  tenantId: string;
  campaignId: string;
  targetKind: ReviewTargetKind;
  targetId: string;
  targetName: string;
  channelType: string | null;
  organizationId: string;
  assigneeUserId: string | null;
  status: ReviewItemStatus;
  findings: QualityFinding[];
  note: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A review item with display names, for lists. */
export interface ReviewItemView extends ReviewItemRecord {
  assigneeName: string | null;
  reviewedByName: string | null;
}

export interface NewReviewItem {
  targetKind: ReviewTargetKind;
  targetId: string;
  targetName: string;
  channelType?: string;
  organizationId: string;
  findings: QualityFinding[];
}

export interface CampaignProgress {
  total: number;
  open: number;
  confirmed: number;
  changesProposed: number;
  unassigned: number;
}

/** A campaign without items. */
export function noProgress(): CampaignProgress {
  return { total: 0, open: 0, confirmed: 0, changesProposed: 0, unassigned: 0 };
}

/** A proposal linked to a review item, as far as review lists need it. */
export interface LinkedProposal {
  id: string;
  reviewItemId: string;
  kind: ProposalKind;
  status: ProposalStatus;
  createdAt: Date;
}

export class ReviewCampaignNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Review campaign not found: ${campaignId}`);
    this.name = 'ReviewCampaignNotFoundError';
  }
}

export class ReviewItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Review item not found: ${itemId}`);
    this.name = 'ReviewItemNotFoundError';
  }
}

const itemView = {
  id: reviewItems.id,
  tenantId: reviewItems.tenantId,
  campaignId: reviewItems.campaignId,
  targetKind: reviewItems.targetKind,
  targetId: reviewItems.targetId,
  targetName: reviewItems.targetName,
  channelType: reviewItems.channelType,
  organizationId: reviewItems.organizationId,
  assigneeUserId: reviewItems.assigneeUserId,
  status: reviewItems.status,
  findings: reviewItems.findings,
  note: reviewItems.note,
  reviewedByUserId: reviewItems.reviewedByUserId,
  reviewedAt: reviewItems.reviewedAt,
  createdAt: reviewItems.createdAt,
  updatedAt: reviewItems.updatedAt,
  assigneeName: sql<
    string | null
  >`(SELECT name FROM users WHERE users.id = ${reviewItems.assigneeUserId})`,
  reviewedByName: sql<
    string | null
  >`(SELECT name FROM users WHERE users.id = ${reviewItems.reviewedByUserId})`,
};

const KIND_ORDER = sql`CASE ${reviewItems.targetKind} WHEN 'organisation' THEN 0 WHEN 'service' THEN 1 ELSE 2 END`;

/** Persistence for review campaigns and their items; role checks live in reviewCampaigns.ts. */
export class ReviewService {
  constructor(private readonly db: Database) {}

  async createCampaign(input: {
    tenantId: string;
    environment: 'test' | 'production';
    name: string;
    organizationId: string;
    dueDate: string | null;
    createdByUserId: string;
    correlationId: string;
    items: NewReviewItem[];
  }): Promise<ReviewCampaignRecord> {
    return withContext(this.db, { tenantId: input.tenantId }, async (tx) => {
      const [campaign] = await tx
        .insert(reviewCampaigns)
        .values({
          tenantId: input.tenantId,
          environment: input.environment,
          name: input.name,
          organizationId: input.organizationId,
          dueDate: input.dueDate,
          createdByUserId: input.createdByUserId,
          correlationId: input.correlationId,
        })
        .returning();
      if (!campaign) throw new Error('Review campaign insert did not return a row');
      if (input.items.length > 0) {
        await tx
          .insert(reviewItems)
          .values(
            input.items.map((item) => ({
              tenantId: input.tenantId,
              campaignId: campaign.id,
              targetKind: item.targetKind,
              targetId: item.targetId,
              targetName: item.targetName,
              channelType: item.channelType ?? null,
              organizationId: item.organizationId,
              findings: item.findings,
            })),
          )
          .onConflictDoNothing();
      }
      return campaign as ReviewCampaignRecord;
    });
  }

  async listCampaigns(tenantId: string): Promise<ReviewCampaignRecord[]> {
    return withContext(
      this.db,
      { tenantId },
      async (tx) =>
        (await tx
          .select()
          .from(reviewCampaigns)
          .where(eq(reviewCampaigns.tenantId, tenantId))
          .orderBy(desc(reviewCampaigns.createdAt))) as ReviewCampaignRecord[],
    );
  }

  async getCampaign(tenantId: string, campaignId: string): Promise<ReviewCampaignRecord> {
    const [row] = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select()
        .from(reviewCampaigns)
        .where(and(eq(reviewCampaigns.tenantId, tenantId), eq(reviewCampaigns.id, campaignId))),
    );
    if (!row) throw new ReviewCampaignNotFoundError(campaignId);
    return row as ReviewCampaignRecord;
  }

  async findOpenCampaign(
    tenantId: string,
    environment: 'test' | 'production',
    organizationId: string,
  ): Promise<ReviewCampaignRecord | undefined> {
    const [row] = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select()
        .from(reviewCampaigns)
        .where(
          and(
            eq(reviewCampaigns.tenantId, tenantId),
            eq(reviewCampaigns.environment, environment),
            eq(reviewCampaigns.organizationId, organizationId),
            eq(reviewCampaigns.status, 'open'),
          ),
        ),
    );
    return row as ReviewCampaignRecord | undefined;
  }

  async closeCampaign(tenantId: string, campaignId: string): Promise<ReviewCampaignRecord> {
    const [row] = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .update(reviewCampaigns)
        .set({ status: 'closed', closedAt: new Date() })
        .where(and(eq(reviewCampaigns.tenantId, tenantId), eq(reviewCampaigns.id, campaignId)))
        .returning(),
    );
    if (!row) throw new ReviewCampaignNotFoundError(campaignId);
    return row as ReviewCampaignRecord;
  }

  async progress(tenantId: string, campaignIds: string[]): Promise<Map<string, CampaignProgress>> {
    const result = new Map<string, CampaignProgress>();
    if (campaignIds.length === 0) return result;
    const rows = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select({
          campaignId: reviewItems.campaignId,
          total: sql<number>`count(*)::int`,
          open: sql<number>`count(*) FILTER (WHERE ${reviewItems.status} = 'open')::int`,
          confirmed: sql<number>`count(*) FILTER (WHERE ${reviewItems.status} = 'confirmed')::int`,
          changesProposed: sql<number>`count(*) FILTER (WHERE ${reviewItems.status} = 'changes_proposed')::int`,
          unassigned: sql<number>`count(*) FILTER (WHERE ${reviewItems.assigneeUserId} IS NULL)::int`,
        })
        .from(reviewItems)
        .where(
          and(eq(reviewItems.tenantId, tenantId), inArray(reviewItems.campaignId, campaignIds)),
        )
        .groupBy(reviewItems.campaignId),
    );
    for (const id of campaignIds) {
      result.set(id, noProgress());
    }
    for (const row of rows) {
      const { campaignId, ...counts } = row;
      result.set(campaignId, counts);
    }
    return result;
  }

  async listItems(
    tenantId: string,
    campaignId: string,
    filter: { assigneeUserId?: string; status?: ReviewItemStatus } = {},
  ): Promise<ReviewItemView[]> {
    return withContext(
      this.db,
      { tenantId },
      async (tx) =>
        (await tx
          .select(itemView)
          .from(reviewItems)
          .where(
            and(
              eq(reviewItems.tenantId, tenantId),
              eq(reviewItems.campaignId, campaignId),
              filter.assigneeUserId
                ? eq(reviewItems.assigneeUserId, filter.assigneeUserId)
                : undefined,
              filter.status ? eq(reviewItems.status, filter.status) : undefined,
            ),
          )
          .orderBy(KIND_ORDER, asc(reviewItems.targetName))) as ReviewItemView[],
    );
  }

  /** Open items assigned to `userId` in the tenant's open campaigns. */
  async listOpenItemsFor(tenantId: string, userId: string): Promise<ReviewItemView[]> {
    return withContext(
      this.db,
      { tenantId },
      async (tx) =>
        (await tx
          .select(itemView)
          .from(reviewItems)
          .innerJoin(reviewCampaigns, eq(reviewCampaigns.id, reviewItems.campaignId))
          .where(
            and(
              eq(reviewItems.tenantId, tenantId),
              eq(reviewItems.assigneeUserId, userId),
              eq(reviewItems.status, 'open'),
              eq(reviewCampaigns.status, 'open'),
            ),
          )
          .orderBy(
            asc(reviewCampaigns.createdAt),
            KIND_ORDER,
            asc(reviewItems.targetName),
          )) as ReviewItemView[],
    );
  }

  async getItem(tenantId: string, itemId: string): Promise<ReviewItemView> {
    const [row] = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select(itemView)
        .from(reviewItems)
        .where(and(eq(reviewItems.tenantId, tenantId), eq(reviewItems.id, itemId))),
    );
    if (!row) throw new ReviewItemNotFoundError(itemId);
    return row as ReviewItemView;
  }

  /**
   * Assigns items of one campaign to a reviewer: the given ids, or else every
   * item matching the filter (by default only unassigned ones). Returns the
   * number of items assigned.
   */
  async assignItems(
    tenantId: string,
    campaignId: string,
    assigneeUserId: string,
    selection: {
      itemIds?: string[];
      targetKind?: ReviewTargetKind;
      organizationId?: string;
      onlyUnassigned?: boolean;
    },
  ): Promise<number> {
    const rows = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .update(reviewItems)
        .set({ assigneeUserId, updatedAt: new Date() })
        .where(
          and(
            eq(reviewItems.tenantId, tenantId),
            eq(reviewItems.campaignId, campaignId),
            selection.itemIds ? inArray(reviewItems.id, selection.itemIds) : undefined,
            selection.targetKind ? eq(reviewItems.targetKind, selection.targetKind) : undefined,
            selection.organizationId
              ? eq(reviewItems.organizationId, selection.organizationId)
              : undefined,
            selection.onlyUnassigned ? isNull(reviewItems.assigneeUserId) : undefined,
          ),
        )
        .returning({ id: reviewItems.id }),
    );
    return rows.length;
  }

  async setItemStatus(
    tenantId: string,
    itemId: string,
    status: ReviewItemStatus,
    reviewedByUserId: string | null,
    note: string | null,
  ): Promise<ReviewItemView> {
    const now = new Date();
    await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .update(reviewItems)
        .set({
          status,
          note,
          reviewedByUserId,
          reviewedAt: status === 'open' ? null : now,
          updatedAt: now,
        })
        .where(and(eq(reviewItems.tenantId, tenantId), eq(reviewItems.id, itemId))),
    );
    return this.getItem(tenantId, itemId);
  }

  async linkedProposals(tenantId: string, itemIds: string[]): Promise<LinkedProposal[]> {
    if (itemIds.length === 0) return [];
    const rows = await withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select({
          id: proposals.id,
          reviewItemId: proposals.reviewItemId,
          kind: proposals.kind,
          status: proposals.status,
          createdAt: proposals.createdAt,
        })
        .from(proposals)
        .where(and(eq(proposals.tenantId, tenantId), inArray(proposals.reviewItemId, itemIds)))
        .orderBy(asc(proposals.createdAt)),
    );
    return rows.filter((row): row is LinkedProposal => row.reviewItemId !== null);
  }

  /** Display names for user ids, e.g. campaign creators. */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import {
  proposalComments,
  proposalKindEnum,
  proposals,
  proposalStatusEnum,
  users,
} from '../db/schema/index.js';
import type { Service } from '../ptv/domain.js';
import type { ServiceDiffEntry } from '../mcp/proposeChanges.js';

export type ProposalStatus = (typeof proposalStatusEnum.enumValues)[number];
export type ProposalKind = (typeof proposalKindEnum.enumValues)[number];

export interface ProposalRecord {
  id: string;
  tenantId: string;
  kind: ProposalKind;
  /** The target service or channel; for `service_create`, the new service once applied, else ''. */
  serviceId: string;
  environment: 'test' | 'production';
  proposedByUserId: string;
  status: ProposalStatus;
  changes: Partial<Service>;
  queuedDiff: ServiceDiffEntry[];
  correlationId: string;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProposalComment {
  id: string;
  userId: string;
  /** Display name of the author, for the review page. */
  userName: string;
  body: string;
  createdAt: Date;
}

export class ProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`Proposal not found: ${proposalId}`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalAlreadyResolvedError extends Error {
  constructor(proposalId: string, status: ProposalStatus) {
    super(`Proposal ${proposalId} is already ${status}`);
    this.name = 'ProposalAlreadyResolvedError';
  }
}

export class ProposalService {
  constructor(private readonly db: Database) {}

  async createPending(input: {
    tenantId: string;
    kind?: ProposalKind;
    serviceId: string;
    environment: 'test' | 'production';
    proposedByUserId: string;
    changes: Partial<Service>;
    queuedDiff: ServiceDiffEntry[];
    correlationId: string;
  }): Promise<ProposalRecord> {
    const row = await withContext(this.db, { tenantId: input.tenantId }, async (tx) => {
      const created = await tx
        .insert(proposals)
        .values({
          tenantId: input.tenantId,
          kind: input.kind ?? 'service_update',
          serviceId: input.serviceId,
          environment: input.environment,
          proposedByUserId: input.proposedByUserId,
          status: 'pending',
          changes: input.changes,
          queuedDiff: input.queuedDiff,
          correlationId: input.correlationId,
        })
        .returning();
      return created[0];
    });
    if (!row) {
      throw new Error('Proposal insert did not return a row');
    }
    return row as ProposalRecord;
  }

  async listForTenant(
    tenantId: string,
    options?: { status?: ProposalStatus; limit?: number },
  ): Promise<ProposalRecord[]> {
    return withContext(
      this.db,
      { tenantId },
      async (tx) =>
        (await tx.query.proposals.findMany({
          where: and(
            eq(proposals.tenantId, tenantId),
            options?.status ? eq(proposals.status, options.status) : undefined,
          ),
          orderBy: desc(proposals.createdAt),
          limit: options?.limit ?? 100,
        })) as ProposalRecord[],
    );
  }

  async getById(tenantId: string, proposalId: string): Promise<ProposalRecord> {
    const row = await withContext(this.db, { tenantId }, async (tx) =>
      tx.query.proposals.findFirst({
        where: and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)),
      }),
    );
    if (!row) {
      throw new ProposalNotFoundError(proposalId);
    }
    return row as ProposalRecord;
  }

  async markResolved(
    tenantId: string,
    proposalId: string,
    status: Exclude<ProposalStatus, 'pending'>,
    resolvedByUserId: string,
    /** Records the id PTV gave a service created by this proposal. */
    serviceId?: string,
  ): Promise<ProposalRecord> {
    const current = await this.getById(tenantId, proposalId);
    if (current.status !== 'pending') {
      throw new ProposalAlreadyResolvedError(proposalId, current.status);
    }
    const now = new Date();
    const row = await withContext(this.db, { tenantId }, async (tx) => {
      const updated = await tx
        .update(proposals)
        .set({
          status,
          resolvedByUserId,
          resolvedAt: now,
          updatedAt: now,
          ...(serviceId ? { serviceId } : {}),
        })
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
        .returning();
      return updated[0];
    });
    if (!row) {
      throw new ProposalNotFoundError(proposalId);
    }
    return row as ProposalRecord;
  }

  async addComment(
    tenantId: string,
    proposalId: string,
    userId: string,
    body: string,
  ): Promise<ProposalComment> {
    await this.getById(tenantId, proposalId);
    const row = await withContext(this.db, { tenantId }, async (tx) => {
      const created = await tx
        .insert(proposalComments)
        .values({ tenantId, proposalId, userId, body })
        .returning();
      return created[0];
    });
    if (!row) throw new Error('Comment insert did not return a row');
    const [comment] = (await this.listComments(tenantId, proposalId)).filter(
      (entry) => entry.id === row.id,
    );
    return comment!;
  }

  /** Oldest first, with each author's display name. */
  async listComments(tenantId: string, proposalId: string): Promise<ProposalComment[]> {
    return withContext(this.db, { tenantId }, async (tx) =>
      tx
        .select({
          id: proposalComments.id,
          userId: proposalComments.userId,
          userName: users.name,
          body: proposalComments.body,
          createdAt: proposalComments.createdAt,
        })
        .from(proposalComments)
        .innerJoin(users, eq(users.id, proposalComments.userId))
        .where(
          and(eq(proposalComments.tenantId, tenantId), eq(proposalComments.proposalId, proposalId)),
        )
        .orderBy(asc(proposalComments.createdAt)),
    );
  }
}

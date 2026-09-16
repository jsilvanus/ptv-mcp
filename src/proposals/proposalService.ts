import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { proposals, proposalStatusEnum } from '../db/schema/index.js';
import type { Service } from '../ptv/domain.js';
import type { ServiceDiffEntry } from '../mcp/proposeChanges.js';

export type ProposalStatus = (typeof proposalStatusEnum.enumValues)[number];

export interface ProposalRecord {
  id: string;
  tenantId: string;
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
    return withContext(this.db, { tenantId }, async (tx) =>
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
  ): Promise<ProposalRecord> {
    const current = await this.getById(tenantId, proposalId);
    if (current.status !== 'pending') {
      throw new ProposalAlreadyResolvedError(proposalId, current.status);
    }
    const now = new Date();
    const row = await withContext(this.db, { tenantId }, async (tx) => {
      const updated = await tx
        .update(proposals)
        .set({ status, resolvedByUserId, resolvedAt: now, updatedAt: now })
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
        .returning();
      return updated[0];
    });
    if (!row) {
      throw new ProposalNotFoundError(proposalId);
    }
    return row as ProposalRecord;
  }
}

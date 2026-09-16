import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries } from '../db/schema/index.js';

export interface AuditEntryInput {
  tenantId: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  apiVersion?: string | null;
  environment?: 'test' | 'production' | null;
  beforeState?: unknown;
  afterState?: unknown;
  prompt?: string | null;
  result: string;
  /** If omitted, AuditService generates a fresh one (crypto.randomUUID()). Pass one explicitly to group several entries under one logical operation (e.g. propose -> validate -> apply). */
  correlationId?: string;
}

export interface AuditEntryRecord extends Required<
  Omit<
    AuditEntryInput,
    'userId' | 'resourceId' | 'apiVersion' | 'environment' | 'beforeState' | 'afterState' | 'prompt'
  >
> {
  id: string;
  correlationId: string;
  userId: string | null;
  resourceId: string | null;
  apiVersion: string | null;
  environment: 'test' | 'production' | null;
  beforeState: unknown;
  afterState: unknown;
  prompt: string | null;
  createdAt: Date;
}

/**
 * Append-only audit trail (Phase 3 Stream C). Groups entries by `correlationId`
 * to track logical operations; records `environment` and `apiVersion` so every
 * action traces back to which adapter handled it; `userId` attribution aligns
 * with PTV's own userName field for GDPR auditability.
 * See docs/phase-plan.md § Phase 3, Stream C.
 */
export class AuditService {
  constructor(private readonly db: Database) {}

  /**
   * Inserts one audit entry. Generates correlationId if not supplied.
   * Returns the persisted row.
   */
  async record(entry: AuditEntryInput): Promise<AuditEntryRecord> {
    const correlationId = entry.correlationId ?? randomUUID();
    const result = await withContext(this.db, { tenantId: entry.tenantId }, async (tx) => {
      const rows = await tx
        .insert(auditEntries)
        .values({
          tenantId: entry.tenantId,
          userId: entry.userId ?? null,
          correlationId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          apiVersion: entry.apiVersion ?? null,
          environment: entry.environment ?? null,
          beforeState: entry.beforeState ?? null,
          afterState: entry.afterState ?? null,
          prompt: entry.prompt ?? null,
          result: entry.result,
        })
        .returning();
      return rows[0];
    });

    if (!result) {
      throw new Error('Audit entry insert did not return a row');
    }

    return result as AuditEntryRecord;
  }

  /**
   * Reads audit entries for one tenant, optionally filtered by resourceType
   * and/or correlationId, ordered descending by createdAt, capped by limit
   * (default 100). RLS ensures no cross-tenant leakage.
   */
  async listForTenant(
    tenantId: string,
    options?: { resourceType?: string; correlationId?: string; limit?: number },
  ): Promise<AuditEntryRecord[]> {
    return withContext(this.db, { tenantId }, async (tx) =>
      tx.query.auditEntries.findMany({
        where: and(
          eq(auditEntries.tenantId, tenantId),
          options?.resourceType ? eq(auditEntries.resourceType, options.resourceType) : undefined,
          options?.correlationId
            ? eq(auditEntries.correlationId, options.correlationId)
            : undefined,
        ),
        orderBy: desc(auditEntries.createdAt),
        limit: options?.limit ?? 100,
      }),
    );
  }

  /**
   * All entries sharing one correlationId for one tenant, ordered ascending
   * by createdAt (the order they happened). Useful for tracing a logical
   * operation (e.g. propose→validate→apply chain) from start to finish.
   * No limit — a real chain could exceed 100 entries.
   */
  async listByCorrelationId(tenantId: string, correlationId: string): Promise<AuditEntryRecord[]> {
    return withContext(this.db, { tenantId }, async (tx) =>
      tx.query.auditEntries.findMany({
        where: and(
          eq(auditEntries.tenantId, tenantId),
          eq(auditEntries.correlationId, correlationId),
        ),
        orderBy: auditEntries.createdAt,
      }),
    );
  }
}

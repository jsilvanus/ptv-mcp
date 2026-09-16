import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { AuditEntryInput, AuditEntryRecord, AuditService } from '../../audit/auditService.js';

/**
 * A minimal fake `AuditService` for unit-testing tool modules without a
 * real Postgres — only `record` is implemented, since that's all this
 * layer calls. `recordCalls` holds the *resolved* entry (with a generated
 * `correlationId` backfilled when the caller omitted one), matching what
 * the real `AuditService.record` returns — not the raw, possibly-partial
 * input — so assertions on `recordCalls[i].correlationId` behave the same
 * way against the fake as against Postgres.
 */
export function fakeAuditService(): AuditService & { recordCalls: AuditEntryRecord[] } {
  const recordCalls: AuditEntryRecord[] = [];
  const record = vi.fn(async (entry: AuditEntryInput): Promise<AuditEntryRecord> => {
    const resolved: AuditEntryRecord = {
      id: randomUUID(),
      correlationId: entry.correlationId ?? randomUUID(),
      tenantId: entry.tenantId,
      userId: entry.userId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      apiVersion: entry.apiVersion ?? null,
      environment: entry.environment ?? null,
      beforeState: entry.beforeState ?? null,
      afterState: entry.afterState ?? null,
      prompt: entry.prompt ?? null,
      result: entry.result,
      createdAt: new Date(),
    };
    recordCalls.push(resolved);
    return resolved;
  });
  return { record, recordCalls } as unknown as AuditService & { recordCalls: AuditEntryRecord[] };
}

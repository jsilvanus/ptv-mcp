import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validService } from '../ptv/testing/fixtures.js';
import type { Service } from '../ptv/domain.js';
import { V11ChangeValidator } from '../validation/changeValidator.js';
import { fakeAuditService } from './testing/fakeAuditService.js';
import { validateChanges } from './validateChanges.js';
import type { ToolContext } from './toolContext.js';

const ctx: ToolContext = { tenantId: 'tenant-1', environment: 'test', actingUserId: 'user-1' };

const service = validService();

describe('validateChanges', () => {
  it('returns valid:true and records a Valid audit entry for a valid proposal', async () => {
    const audit = fakeAuditService();
    const result = await validateChanges(audit, new V11ChangeValidator(), ctx, service);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(audit.recordCalls).toHaveLength(1);
    expect(audit.recordCalls[0]).toMatchObject({
      action: 'ValidateServiceChange',
      resourceType: 'Service',
      resourceId: 'svc-1',
      apiVersion: 'v11',
      result: 'Valid',
    });
  });

  it('returns valid:false with errors and records an Invalid audit entry', async () => {
    const audit = fakeAuditService();
    const invalid: Service = { ...service, languages: [] };
    const result = await validateChanges(audit, new V11ChangeValidator(), ctx, invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: 'languages' }));
    expect(audit.recordCalls[0]?.result).toBe('Invalid');
  });

  it('reuses a caller-supplied correlationId to join the audit chain', async () => {
    const audit = fakeAuditService();
    const correlationId = randomUUID();
    const result = await validateChanges(
      audit,
      new V11ChangeValidator(),
      ctx,
      service,
      correlationId,
    );
    expect(result.correlationId).toBe(correlationId);
    expect(audit.recordCalls[0]?.correlationId).toBe(correlationId);
  });
});

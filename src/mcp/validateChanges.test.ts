import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Service } from '../ptv/domain.js';
import { V11ChangeValidator } from '../validation/changeValidator.js';
import { fakeAuditService } from './testing/fakeAuditService.js';
import { validateChanges } from './validateChanges.js';
import type { ToolContext } from './toolContext.js';

const ctx: ToolContext = { tenantId: 'tenant-1', environment: 'test', actingUserId: 'user-1' };

const validService: Service = {
  id: 'svc-1',
  organizationId: 'org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Palvelu' },
  summaries: {},
  descriptions: {},
  serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
  ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
  targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: [],
  modifiedAt: '2026-01-01T00:00:00Z',
};

describe('validateChanges', () => {
  it('returns valid:true and records a Valid audit entry for a valid proposal', async () => {
    const audit = fakeAuditService();
    const result = await validateChanges(audit, new V11ChangeValidator(), ctx, validService);

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
    const invalid: Service = { ...validService, languages: [] };
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
      validService,
      correlationId,
    );
    expect(result.correlationId).toBe(correlationId);
    expect(audit.recordCalls[0]?.correlationId).toBe(correlationId);
  });
});

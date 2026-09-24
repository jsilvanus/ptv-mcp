import { describe, expect, it, vi } from 'vitest';
import type { PtvAdapter } from '../ptv/adapter.js';
import type { PtvAdapterRegistry, PtvAdapterResolutionRequest } from '../ptv/registry.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import type { Service } from '../ptv/domain.js';
import { V11ChangeValidator } from '../validation/changeValidator.js';
import { fakeAuditService } from './testing/fakeAuditService.js';
import { NotAuthorizedError } from './authorization.js';
import { applyChanges, exportForManualPublish, ValidationFailedError } from './applyOrExport.js';
import type { ToolContext } from './toolContext.js';

const ctx: ToolContext = {
  tenantId: 'tenant-1',
  environment: 'test',
  readApiVersion: 'v11',
  writeApiVersion: 'v11',
  actingUserId: 'user-1',
};
const fakeEditorResolver = async () => 'approver' as const;
const fakeReaderResolver = async () => 'contributor' as const;

const baseService: Service = {
  id: 'svc-1',
  organizationId: 'org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Vanha nimi' },
  summaries: { fi: 'Tiivistelmä' },
  descriptions: { fi: 'Kuvaus' },
  serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
  ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
  targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: [],
  modifiedAt: '2026-01-01T00:00:00Z',
};

function fakeRegistry(
  adapter: PtvAdapter,
): PtvAdapterRegistry & { resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(async (_req: PtvAdapterResolutionRequest) => adapter);
  return { resolve };
}

function buildAdapter(supportsWrite: boolean): InMemoryPtvAdapter {
  return new InMemoryPtvAdapter({
    services: [baseService],
    capabilities: {
      apiVersion: 'v11',
      environment: 'test',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite,
      supportsDraftRead: false,
    },
  });
}

describe('exportForManualPublish', () => {
  it('renders a per-language preview and records ReadyForManualPublish', async () => {
    const registry = fakeRegistry(buildAdapter(false));
    const audit = fakeAuditService();
    const result = await exportForManualPublish(fakeEditorResolver, registry, audit, ctx, 'svc-1', {
      names: { fi: 'Uusi nimi' },
    });

    expect(result.languages.fi).toEqual({
      name: 'Uusi nimi',
      summary: 'Tiivistelmä',
      description: 'Kuvaus',
    });
    expect(audit.recordCalls.map((c) => c.action)).toEqual([
      'ProposeServiceChange',
      'ExportForManualPublish',
    ]);
    expect(audit.recordCalls[1]?.result).toBe('ReadyForManualPublish');
    // Both steps share one correlationId, per the sync point's "every step in the audit log."
    expect(audit.recordCalls[0]?.correlationId).toBe(audit.recordCalls[1]?.correlationId);
  });

  it('works even when the adapter cannot write (this is the no-write-capability fallback)', async () => {
    const registry = fakeRegistry(buildAdapter(false));
    const result = await exportForManualPublish(
      fakeEditorResolver,
      registry,
      fakeAuditService(),
      ctx,
      'svc-1',
      {},
    );
    expect(result.serviceId).toBe('svc-1');
  });

  it('rejects a Reader — exporting requires at least Editor (docs/plan.md role model)', async () => {
    const registry = fakeRegistry(buildAdapter(false));
    await expect(
      exportForManualPublish(fakeReaderResolver, registry, fakeAuditService(), ctx, 'svc-1', {}),
    ).rejects.toThrow(NotAuthorizedError);
  });
});

describe('applyChanges', () => {
  it('returns an explicit read-only error when no write API is selected', async () => {
    const registry = fakeRegistry(buildAdapter(true));
    const readOnlyContext: ToolContext = {
      ...ctx,
      writeApiVersion: undefined,
    };

    await expect(
      applyChanges(
        fakeEditorResolver,
        registry,
        fakeAuditService(),
        new V11ChangeValidator(),
        readOnlyContext,
        'svc-1',
        {},
      ),
    ).rejects.toThrow('No write API version is selected');
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('validates, writes via a write-capable adapter, and records both steps', async () => {
    const registry = fakeRegistry(buildAdapter(true));
    const audit = fakeAuditService();
    const result = await applyChanges(
      fakeEditorResolver,
      registry,
      audit,
      new V11ChangeValidator(),
      ctx,
      'svc-1',
      {
        names: { fi: 'Uusi nimi' },
      },
    );

    expect(result.serviceId).toBe('svc-1');
    const actions = audit.recordCalls.map((c) => c.action);
    expect(actions).toEqual([
      'ProposeServiceChange',
      'ValidateServiceChange',
      'ApplyServiceChange',
    ]);
    expect(audit.recordCalls[2]).toMatchObject({
      result: 'Success',
      apiVersion: 'v11',
      environment: 'test',
    });
    // All three share one correlationId.
    const correlationIds = new Set(audit.recordCalls.map((c) => c.correlationId));
    expect(correlationIds.size).toBe(1);
  });

  it('throws ValidationFailedError and never calls the adapter when the proposal is invalid', async () => {
    const registry = fakeRegistry(buildAdapter(true));
    const audit = fakeAuditService();
    await expect(
      applyChanges(fakeEditorResolver, registry, audit, new V11ChangeValidator(), ctx, 'svc-1', {
        languages: [],
      }),
    ).rejects.toThrow(ValidationFailedError);

    const actions = audit.recordCalls.map((c) => c.action);
    expect(actions).toEqual(['ProposeServiceChange', 'ValidateServiceChange']);
    expect(audit.recordCalls[1]?.result).toBe('Invalid');
  });

  it('propagates a PtvAdapterResolutionError from the registry (e.g. no write capability) without silently succeeding', async () => {
    const registry: PtvAdapterRegistry = {
      resolve: vi.fn(async (req: PtvAdapterResolutionRequest) => {
        if (req.operation === 'write') {
          throw new Error('operation_not_supported');
        }
        return buildAdapter(false);
      }),
    };
    await expect(
      applyChanges(
        fakeEditorResolver,
        registry,
        fakeAuditService(),
        new V11ChangeValidator(),
        ctx,
        'svc-1',
        {},
      ),
    ).rejects.toThrow('operation_not_supported');
  });

  it('records a Failed audit entry (not Success) when the underlying write throws', async () => {
    const adapter = buildAdapter(true);
    vi.spyOn(adapter, 'applyServiceChange').mockRejectedValue(new Error('PTV rejected the write'));
    const registry = fakeRegistry(adapter);
    const audit = fakeAuditService();

    await expect(
      applyChanges(fakeEditorResolver, registry, audit, new V11ChangeValidator(), ctx, 'svc-1', {}),
    ).rejects.toThrow('PTV rejected the write');

    const applyEntry = audit.recordCalls.find((c) => c.action === 'ApplyServiceChange');
    expect(applyEntry?.result).toBe('Failed');
  });
});

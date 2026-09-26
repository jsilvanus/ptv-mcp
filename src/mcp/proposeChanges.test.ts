import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import { v11Capabilities } from '../ptv/testing/fixtures.js';
import type { Service } from '../ptv/domain.js';
import { fakeAuditService } from './testing/fakeAuditService.js';
import { NotAuthorizedError } from './authorization.js';
import { diffFields, proposeChanges, ServiceNotFoundError } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

const ctx: ToolContext = { tenantId: 'tenant-1', environment: 'test', actingUserId: 'user-1' };
const fakeEditorResolver = async () => 'approver' as const;
const fakeReaderResolver = async () => 'contributor' as const;
const fakeNoMembershipResolver = async () => null;

const baseService: Service = {
  id: 'svc-1',
  organizationId: 'org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Vanha nimi', sv: 'Gammalt namn' },
  summaries: {},
  descriptions: { fi: 'Kuvaus' },
  serviceClasses: [{ uri: 'http://example/class/1', names: {} }],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi', 'sv'],
  serviceChannelIds: [],
  modifiedAt: '2026-01-01T00:00:00Z',
};

function fakeRegistry(adapter: InMemoryPtvAdapter): PtvAdapterRegistry {
  return { resolve: vi.fn(async () => adapter) };
}

function buildAdapter(services: Service[] = [baseService]): InMemoryPtvAdapter {
  return new InMemoryPtvAdapter({
    services,
    capabilities: v11Capabilities(),
  });
}

describe('diffFields', () => {
  it('produces no entries when changes is empty', () => {
    expect(diffFields(baseService, {})).toEqual([]);
  });

  it('ignores key order and PTV-filled hour defaults, so read-back data equals the proposal', () => {
    const current = {
      ...baseService,
      phoneNumbers: [{ number: '401234567', language: 'fi', prefixNumber: '+358' }],
      serviceHours: [
        {
          type: 'DaysOfTheWeek',
          validForNow: true,
          openingTimes: [
            { dayFrom: 'Monday', from: '09:00', to: '15:00' },
            { dayFrom: 'Tuesday', from: '09:00', to: '15:00' },
          ],
        },
      ],
    } as unknown as Service;
    const changes = {
      phoneNumbers: [{ language: 'fi', prefixNumber: '+358', number: '401234567' }],
      serviceHours: [
        {
          type: 'DaysOfTheWeek',
          openingTimes: [{ dayFrom: 'Monday', dayTo: 'Tuesday', from: '09:00', to: '15:00' }],
        },
      ],
    } as unknown as Partial<Service>;
    expect(diffFields(current, changes)).toEqual([]);
  });

  it('compares classifications by uri, ignoring names and order', () => {
    const current: Service = {
      ...baseService,
      serviceClasses: [
        { uri: 'http://example/class/1', names: { fi: 'Yksi', sv: 'Ett' } },
        { uri: 'http://example/class/2', names: { fi: 'Kaksi' } },
      ],
    };
    expect(
      diffFields(current, {
        serviceClasses: [
          { uri: 'http://example/class/2', names: {} },
          { uri: 'http://example/class/1', names: { fi: 'Yksi' } },
        ],
      }),
    ).toEqual([]);
    expect(
      diffFields(current, { serviceClasses: [{ uri: 'http://example/class/1', names: {} }] }),
    ).toHaveLength(1);
  });

  it('copies known classification names onto proposed entries given by uri or code', () => {
    const current: Service = {
      ...baseService,
      serviceClasses: [
        { code: 'P11.6', uri: 'http://example/class/p11.6', names: { fi: 'Seurakunnat' } },
      ],
    };
    const [entry] = diffFields(current, {
      serviceClasses: [
        { uri: 'http://example/class/p11.6', names: {} },
        { code: 'P27', names: {} },
      ],
    });
    expect(entry?.after).toEqual([
      { uri: 'http://example/class/p11.6', names: { fi: 'Seurakunnat' } },
      { code: 'P27', names: {} },
    ]);
  });

  it('expands a localized field into one entry per changed language', () => {
    const diff = diffFields(baseService, { names: { fi: 'Uusi nimi', sv: 'Gammalt namn' } });
    expect(diff).toEqual([{ field: 'names.fi', before: 'Vanha nimi', after: 'Uusi nimi' }]);
  });

  it('reports a removed language as before/after undefined pair', () => {
    const diff = diffFields(baseService, { names: { fi: 'Vanha nimi' } });
    expect(diff).toEqual([{ field: 'names.sv', before: 'Gammalt namn', after: undefined }]);
  });

  it('reports an added language', () => {
    const diff = diffFields(baseService, {
      names: { fi: 'Vanha nimi', sv: 'Gammalt namn', en: 'New name' },
    });
    expect(diff).toEqual([{ field: 'names.en', before: undefined, after: 'New name' }]);
  });

  it('diffs a non-localized array field as a whole-value replacement', () => {
    const diff = diffFields(baseService, { languages: ['fi'] });
    expect(diff).toEqual([{ field: 'languages', before: ['fi', 'sv'], after: ['fi'] }]);
  });

  it('does not report a field present in changes but identical to the current value', () => {
    const diff = diffFields(baseService, { languages: ['fi', 'sv'] });
    expect(diff).toEqual([]);
  });

  it('reports multiple simultaneous field changes', () => {
    const diff = diffFields(baseService, { languages: ['fi'], organizationId: 'org-2' });
    expect(diff).toContainEqual({ field: 'languages', before: ['fi', 'sv'], after: ['fi'] });
    expect(diff).toContainEqual({ field: 'organizationId', before: 'org-1', after: 'org-2' });
  });
});

describe('proposeChanges', () => {
  it('fetches the current service, merges changes, and computes the diff', async () => {
    const registry = fakeRegistry(buildAdapter());
    const audit = fakeAuditService();
    const result = await proposeChanges(fakeEditorResolver, registry, audit, ctx, 'svc-1', {
      names: { fi: 'Uusi nimi' },
    });

    expect(result.serviceId).toBe('svc-1');
    expect(result.current).toEqual(baseService);
    expect(result.proposed.names).toEqual({ fi: 'Uusi nimi' });
    expect(result.diff).toEqual([
      { field: 'names.fi', before: 'Vanha nimi', after: 'Uusi nimi' },
      { field: 'names.sv', before: 'Gammalt namn', after: undefined },
    ]);
  });

  it('never mutates the underlying current service', async () => {
    const registry = fakeRegistry(buildAdapter());
    await proposeChanges(fakeEditorResolver, registry, fakeAuditService(), ctx, 'svc-1', {
      languages: ['fi'],
    });
    const adapter = buildAdapter();
    const stillOriginal = await adapter.getService('svc-1');
    expect(stillOriginal?.languages).toEqual(['fi', 'sv']);
  });

  it('throws ServiceNotFoundError for an unknown service id', async () => {
    const registry = fakeRegistry(buildAdapter());
    await expect(
      proposeChanges(fakeEditorResolver, registry, fakeAuditService(), ctx, 'unknown', {}),
    ).rejects.toThrow(ServiceNotFoundError);
  });

  it('resolves via the registry for a read operation, not write', async () => {
    const adapter = buildAdapter();
    const registry = fakeRegistry(adapter);
    await proposeChanges(fakeEditorResolver, registry, fakeAuditService(), ctx, 'svc-1', {});
    expect(registry.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'read',
        tenantId: ctx.tenantId,
        actingUserId: ctx.actingUserId,
      }),
    );
  });

  it('records a ProposeServiceChange audit entry and returns its correlationId', async () => {
    const registry = fakeRegistry(buildAdapter());
    const audit = fakeAuditService();
    const result = await proposeChanges(fakeEditorResolver, registry, audit, ctx, 'svc-1', {
      languages: ['fi'],
    });

    expect(audit.recordCalls).toHaveLength(1);
    expect(audit.recordCalls[0]).toMatchObject({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ProposeServiceChange',
      resourceType: 'Service',
      resourceId: 'svc-1',
      result: 'Proposed',
    });
    expect(result.correlationId).toBeTruthy();
  });

  it('reuses a caller-supplied correlationId instead of generating a new one', async () => {
    const registry = fakeRegistry(buildAdapter());
    const audit = fakeAuditService();
    const correlationId = randomUUID();
    const result = await proposeChanges(
      fakeEditorResolver,
      registry,
      audit,
      ctx,
      'svc-1',
      {},
      correlationId,
    );
    expect(result.correlationId).toBe(correlationId);
    expect(audit.recordCalls[0]?.correlationId).toBe(correlationId);
  });

  it('rejects a Reader — proposing a change requires at least Editor (docs/plan.md role model)', async () => {
    const registry = fakeRegistry(buildAdapter());
    await expect(
      proposeChanges(fakeReaderResolver, registry, fakeAuditService(), ctx, 'svc-1', {}),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it('rejects a user with no membership in the tenant at all', async () => {
    const registry = fakeRegistry(buildAdapter());
    await expect(
      proposeChanges(fakeNoMembershipResolver, registry, fakeAuditService(), ctx, 'svc-1', {}),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it('never resolves a PTV adapter when the role check fails first', async () => {
    const adapter = buildAdapter();
    const registry = fakeRegistry(adapter);
    await expect(
      proposeChanges(fakeReaderResolver, registry, fakeAuditService(), ctx, 'svc-1', {}),
    ).rejects.toThrow(NotAuthorizedError);
    expect(registry.resolve).not.toHaveBeenCalled();
  });
});

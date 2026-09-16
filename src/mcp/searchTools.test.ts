import { describe, expect, it, vi } from 'vitest';
import type { PtvAdapter } from '../ptv/adapter.js';
import type { PtvAdapterRegistry, PtvAdapterResolutionRequest } from '../ptv/registry.js';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import type { Organization, Service } from '../ptv/domain.js';
import * as searchTools from './searchTools.js';
import type { ToolContext } from './toolContext.js';

const ctx: ToolContext = { tenantId: 'tenant-1', environment: 'test', actingUserId: 'user-1' };

function fakeRegistry(adapter: PtvAdapter): PtvAdapterRegistry & {
  resolve: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn(async (_req: PtvAdapterResolutionRequest) => adapter);
  return { resolve };
}

const service: Service = {
  id: 'svc-1',
  organizationId: 'org-1',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Palvelu' },
  summaries: {},
  descriptions: {},
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: [],
  modifiedAt: '2026-01-01T00:00:00Z',
};

const organization: Organization = {
  id: 'org-1',
  publishingStatus: 'Published',
  names: { fi: 'Organisaatio' },
  modifiedAt: '2026-01-01T00:00:00Z',
  parentOrganizationId: 'org-root',
};

const rootOrganization: Organization = {
  id: 'org-root',
  publishingStatus: 'Published',
  names: { fi: 'Juuriorganisaatio' },
  modifiedAt: '2026-01-01T00:00:00Z',
};

function buildAdapter(): InMemoryPtvAdapter {
  return new InMemoryPtvAdapter({
    services: [service],
    organizations: [organization, rootOrganization],
    codeLists: { languages: [{ code: 'fi', names: { fi: 'suomi' } }] },
    connections: [{ serviceId: 'svc-1', channelId: 'chan-1', modifiedAt: '2026-01-01T00:00:00Z' }],
    capabilities: {
      apiVersion: 'v11',
      environment: 'test',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    },
  });
}

describe('search tools', () => {
  it('searchServices resolves a read adapter and delegates', async () => {
    const adapter = buildAdapter();
    const registry = fakeRegistry(adapter);
    const result = await searchTools.searchServices(registry, ctx, { page: 1, pageSize: 10 });
    expect(result.items).toEqual([service]);
    expect(registry.resolve).toHaveBeenCalledWith({
      tenantId: ctx.tenantId,
      environment: ctx.environment,
      operation: 'read',
      actingUserId: ctx.actingUserId,
    });
  });

  it('getService returns the matching service', async () => {
    const registry = fakeRegistry(buildAdapter());
    expect(await searchTools.getService(registry, ctx, 'svc-1')).toEqual(service);
    expect(await searchTools.getService(registry, ctx, 'unknown')).toBeNull();
  });

  it('getOrganisationHierarchy walks up through parents', async () => {
    const registry = fakeRegistry(buildAdapter());
    const hierarchy = await searchTools.getOrganisationHierarchy(registry, ctx, 'org-1');
    expect(hierarchy.map((o) => o.id)).toEqual(['org-1', 'org-root']);
  });

  it('searchConnections delegates to getConnectionsFor', async () => {
    const registry = fakeRegistry(buildAdapter());
    const connections = await searchTools.searchConnections(registry, ctx, 'svc-1');
    expect(connections).toEqual([
      { serviceId: 'svc-1', channelId: 'chan-1', modifiedAt: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('listCodes returns the requested code list', async () => {
    const registry = fakeRegistry(buildAdapter());
    const codes = await searchTools.listCodes(registry, ctx, 'languages');
    expect(codes).toEqual([{ code: 'fi', names: { fi: 'suomi' } }]);
  });

  it('searchChannels, getChannel, searchServiceCollections, searchGeneralDescriptions delegate cleanly with empty fixtures', async () => {
    const registry = fakeRegistry(buildAdapter());
    expect((await searchTools.searchChannels(registry, ctx, {})).items).toEqual([]);
    expect(await searchTools.getChannel(registry, ctx, 'nope')).toBeNull();
    expect((await searchTools.searchServiceCollections(registry, ctx, {})).items).toEqual([]);
    expect((await searchTools.searchGeneralDescriptions(registry, ctx, {})).items).toEqual([]);
  });

  it('getOrganisation returns null for an unknown id', async () => {
    const registry = fakeRegistry(buildAdapter());
    expect(await searchTools.getOrganisation(registry, ctx, 'unknown')).toBeNull();
  });
});

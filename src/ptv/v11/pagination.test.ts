import { describe, expect, it } from 'vitest';
import type { PtvV11Client } from './client.js';
import {
  fetchAllIdNamePairs,
  fetchListByIds,
  fetchOrganizationServiceChannelWindow,
  fetchOrganizationServiceCollectionWindow,
  fetchOrganizationGeneralDescriptionWindow,
  fetchOrganizationServiceWindow,
} from './pagination.js';
import type {
  V11GeneralDescriptionWire,
  V11ServiceCollectionWire,
  V11ServiceWire,
} from './wireModel.js';

const ORGANIZATION_ID = '47e05190-11d1-435d-a657-c7dccbd91603';

function service(id: string, organizationId: string): V11ServiceWire {
  return {
    id,
    type: 'Service',
    publishingStatus: 'Published',
    serviceNames: [{ language: 'fi', value: id }],
    serviceDescriptions: [],
    serviceClasses: [],
    ontologyTerms: [],
    targetGroups: [],
    lifeEvents: [],
    industrialClasses: [],
    languages: ['fi'],
    organizations: [{ organization: { id: organizationId }, roleType: 'Responsible' }],
    serviceChannels: [],
    modified: '2026-01-01T00:00:00Z',
  };
}

function fakeClient(
  get: (path: string, query?: Record<string, string | number | undefined>) => Promise<unknown>,
) {
  return { get } as unknown as PtvV11Client;
}

describe('PTV v11 organization service pagination', () => {
  it('uses the organization endpoint and preserves the organization filter', async () => {
    const calls: Array<{
      path: string;
      query?: Record<string, string | number | undefined> | undefined;
    }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      const page = Number(query?.page);
      return {
        pageNumber: page,
        pageSize: 2,
        pageCount: 2,
        itemList:
          page === 1
            ? [service('riihimaki-1', ORGANIZATION_ID), service('other-1', 'other-org')]
            : [service('riihimaki-2', ORGANIZATION_ID), service('other-2', 'other-org')],
      };
    });

    const result = await fetchOrganizationServiceWindow(client, ORGANIZATION_ID);

    expect(result.items).toHaveLength(4);
    expect(
      result.items.filter((item) =>
        item.organizations.some(
          (org) => org.roleType === 'Responsible' && org.organization.id === ORGANIZATION_ID,
        ),
      ),
    ).toHaveLength(2);
    expect(calls).toEqual([
      {
        path: '/api/v11/Service/list/organization',
        query: { organizationId: ORGANIZATION_ID, page: 1 },
      },
      {
        path: '/api/v11/Service/list/organization',
        query: { organizationId: ORGANIZATION_ID, page: 2 },
      },
    ]);
  });
});

describe('PTV v11 organization catalogue pagination', () => {
  it('enumerates the complete catalogue independently of requested page size', async () => {
    const calls: Array<{
      path: string;
      query?: Record<string, string | number | undefined> | undefined;
    }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      const page = Number(query?.page);
      return {
        pageNumber: page,
        pageSize: 2,
        pageCount: 3,
        itemList:
          page === 1
            ? [
                { id: '1', name: 'Other' },
                { id: '2', name: 'Riihimäen kaupunki' },
              ]
            : page === 2
              ? [
                  { id: '3', name: 'Tuusulan kunta' },
                  { id: '4', name: 'Riihimäen seurakunta' },
                ]
              : [{ id: '5', name: 'Other 2' }],
      };
    });

    const catalog = await fetchAllIdNamePairs(client, '/api/v11/Organization');

    expect(catalog.map((item) => item.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(
      catalog.filter((item) =>
        item.name?.toLocaleLowerCase('fi-FI').includes('riihimäen seurakunta'),
      ),
    ).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.query?.page)).toEqual([1, 2, 3]);
  });

  it('batches full organization fetches in groups of at most 100 GUIDs', async () => {
    const calls: Array<{
      path: string;
      query?: Record<string, string | number | undefined> | undefined;
    }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      return [];
    });

    const ids = Array.from({ length: 201 }, (_, index) => String(index));
    await fetchListByIds<{ id: string }>(client, '/api/v11/Organization/list', ids);

    expect(calls.map((call) => String(call.query?.guids).split(',').length)).toEqual([100, 100, 1]);
  });
});

describe('PTV v11 organization service-channel pagination', () => {
  it('uses the organization endpoint and returns only the requested organization', async () => {
    const calls: Array<{
      path: string;
      query?: Record<string, string | number | undefined> | undefined;
    }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      const page = Number(query?.page);
      return {
        pageNumber: page,
        pageSize: 2,
        pageCount: 2,
        itemList:
          page === 1
            ? [
                {
                  id: 'channel-1',
                  serviceChannelType: 'Phone',
                  organizationId: ORGANIZATION_ID,
                  publishingStatus: 'Published',
                  serviceChannelNames: [{ language: 'fi', value: 'Riihimäki 1' }],
                  serviceChannelDescriptions: [],
                  languages: ['fi'],
                  modified: '2026-01-01T00:00:00Z',
                },
                {
                  id: 'channel-other-1',
                  serviceChannelType: 'WebPage',
                  organizationId: 'other-org',
                  publishingStatus: 'Published',
                  serviceChannelNames: [{ language: 'fi', value: 'Other 1' }],
                  serviceChannelDescriptions: [],
                  languages: ['fi'],
                  modified: '2026-01-01T00:00:00Z',
                },
              ]
            : [
                {
                  id: 'channel-2',
                  serviceChannelType: 'ServiceLocation',
                  organizationId: ORGANIZATION_ID,
                  publishingStatus: 'Published',
                  serviceChannelNames: [{ language: 'fi', value: 'Riihimäki 2' }],
                  serviceChannelDescriptions: [],
                  languages: ['fi'],
                  modified: '2026-01-01T00:00:00Z',
                },
              ],
      };
    });

    const result = await fetchOrganizationServiceChannelWindow(client, ORGANIZATION_ID);

    expect(result.items.map((item) => item.id)).toEqual([
      'channel-1',
      'channel-other-1',
      'channel-2',
    ]);
    expect(calls).toEqual([
      {
        path: '/api/v11/ServiceChannel/list/organization',
        query: { organizationId: ORGANIZATION_ID, page: 1 },
      },
      {
        path: '/api/v11/ServiceChannel/list/organization',
        query: { organizationId: ORGANIZATION_ID, page: 2 },
      },
    ]);
  });
});

describe('PTV v11 organization service-collection pagination', () => {
  it('uses the organization endpoint for ids and fetches full collection entities', async () => {
    const calls: Array<{
      path: string;
      query?: Record<string, string | number | undefined> | undefined;
    }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      if (path === '/api/v11/ServiceCollection/organization') {
        return {
          pageNumber: 1,
          pageSize: 10,
          pageCount: 1,
          itemList: [{ id: 'collection-1', name: 'Collection 1' }],
        };
      }
      const full: V11ServiceCollectionWire = {
        id: 'collection-1',
        publishingStatus: 'Published',
        serviceCollectionNames: [{ language: 'fi', value: 'Collection 1' }],
        serviceCollectionDescriptions: [],
        services: [],
        modified: '2026-01-01T00:00:00Z',
      };
      return full;
    });

    const result = await fetchOrganizationServiceCollectionWindow(client, ORGANIZATION_ID);

    expect(result.items.map((item) => item.id)).toEqual(['collection-1']);
    expect(calls).toEqual([
      {
        path: '/api/v11/ServiceCollection/organization',
        query: { organizationId: ORGANIZATION_ID, page: 1 },
      },
      { path: '/api/v11/ServiceCollection/collection-1' },
    ]);
  });
});

describe('PTV v11 organization general-description pagination', () => {
  it('derives unique general descriptions from organization services', async () => {
    const calls: Array<{
      path: string;
      query?: Record<string, string | number | undefined> | undefined;
    }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      if (path === '/api/v11/Service/list/organization') {
        return {
          pageNumber: 1,
          pageSize: 10,
          pageCount: 1,
          itemList: [
            { ...service('service-1', ORGANIZATION_ID), generalDescriptionId: 'gd-1' },
            { ...service('service-2', ORGANIZATION_ID), generalDescriptionId: 'gd-1' },
            { ...service('service-3', ORGANIZATION_ID), generalDescriptionId: null },
          ],
        };
      }
      const full: V11GeneralDescriptionWire = {
        id: 'gd-1',
        type: 'Service',
        publishingStatus: 'Published',
        names: [{ language: 'fi', value: 'GD 1' }],
        descriptions: [],
        serviceClasses: [],
        ontologyTerms: [],
        targetGroups: [],
        lifeEvents: [],
        industrialClasses: [],
        modified: '2026-01-01T00:00:00Z',
      };
      return full;
    });

    const result = await fetchOrganizationGeneralDescriptionWindow(client, ORGANIZATION_ID);

    expect(result.totalCount).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual(['gd-1']);
    expect(calls.map((call) => call.path)).toEqual([
      '/api/v11/Service/list/organization',
      '/api/v11/GeneralDescription/gd-1',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { PtvV11Client } from './client.js';
import { fetchAllIdNamePairs, fetchListByIds, fetchOrganizationServiceWindow } from './pagination.js';
import type { V11ServiceWire } from './wireModel.js';

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
    const calls: Array<{ path: string; query?: Record<string, string | number | undefined> }> = [];
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
    expect(result.items.filter((item) =>
      item.organizations.some(
        (org) =>
          org.roleType === 'Responsible' &&
          org.organization.id === ORGANIZATION_ID,
      ),
    )).toHaveLength(2);
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
    const calls: Array<{ path: string; query?: Record<string, string | number | undefined> }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      const page = Number(query?.page);
      return {
        pageNumber: page,
        pageSize: 2,
        pageCount: 3,
        itemList:
          page === 1
            ? [{ id: '1', name: 'Other' }, { id: '2', name: 'Riihimäen kaupunki' }]
            : page === 2
              ? [{ id: '3', name: 'Tuusulan kunta' }, { id: '4', name: 'Riihimäen seurakunta' }]
              : [{ id: '5', name: 'Other 2' }],
      };
    });

    const catalog = await fetchAllIdNamePairs(client, '/api/v11/Organization');

    expect(catalog.map((item) => item.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(catalog.filter((item) => item.name?.toLocaleLowerCase('fi-FI').includes('riihimäki'))).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.query?.page)).toEqual([1, 2, 3]);
  });

  it('batches full organization fetches in groups of at most 100 GUIDs', async () => {
    const calls: Array<{ path: string; query?: Record<string, string | number | undefined> }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      return [];
    });

    const ids = Array.from({ length: 201 }, (_, index) => String(index));
    await fetchListByIds<{ id: string }>(client, '/api/v11/Organization/list', ids);

    expect(calls.map((call) => String(call.query?.guids).split(',').length)).toEqual([100, 100, 1]);
  });
});

import { describe, expect, it } from 'vitest';
import type { PtvV11Client } from './client.js';
import { fetchOrganizationServiceWindow } from './pagination.js';
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

import { describe, expect, it } from 'vitest';
import type { PtvV11Client } from './client.js';
import {
  fetchIdWindow,
  fetchListInBatches,
  fetchOrganizationServiceWindow,
} from './pagination.js';
import type { V11ServiceWire } from './wireModel.js';

function fakeClient(
  get: (path: string, query?: Record<string, string | number | undefined>) => Promise<unknown>,
) {
  return { get } as unknown as PtvV11Client;
}

describe('PTV v11 pagination and batching', () => {
  it('never sends more than 100 GUIDs to a /list endpoint', async () => {
    const calls: string[] = [];
    const ids = Array.from({ length: 201 }, (_, i) => 'id-' + i);
    const client = fakeClient(async (_path, query) => {
      calls.push(String(query?.guids ?? ''));
      return [];
    });

    await fetchListInBatches(client, '/api/v11/Service/list', ids);

    expect(calls).toHaveLength(3);
    expect(calls.map((value) => value.split(',').length)).toEqual([100, 100, 1]);
  });

  it('bridges v11 fixed paging to a requested service-id window', async () => {
    const calls: Array<Record<string, string | number | undefined> | undefined> = [];
    const page = (pageNumber: number) => ({
      pageNumber,
      pageSize: 3,
      pageCount: 2,
      itemList: [0, 1, 2].map((i) => ({ id: 'id-' + ((pageNumber - 1) * 3 + i) })),
    });
    const client = fakeClient(async (_path, query) => {
      calls.push(query);
      return page(Number(query?.page));
    });

    const result = await fetchIdWindow(client, '/api/v11/Service', 2, 3);

    expect(result.ids).toEqual(['id-2', 'id-3', 'id-4']);
    expect(calls.map((query) => query?.page)).toEqual([1, 2]);
  });

  it('uses the v11 organization endpoint and its paging instead of a GUID list', async () => {
    const organizationId = '47e05190-11d1-435d-a657-c7dccbd91603';
    const makeService = (id: string): V11ServiceWire => ({
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
    });
    const calls: Array<{ path: string; query?: Record<string, string | number | undefined> }> = [];
    const client = fakeClient(async (path, query) => {
      calls.push({ path, query });
      const pageNumber = Number(query?.page);
      return {
        pageNumber,
        pageSize: 2,
        pageCount: 2,
        itemList: [
          makeService('service-' + pageNumber + '-1'),
          makeService('service-' + pageNumber + '-2'),
        ],
      };
    });

    const result = await fetchOrganizationServiceWindow(client, organizationId, 0, 3);

    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.organizations[0].organization.id === organizationId)).toBe(
      true,
    );
    expect(calls).toEqual([
      { path: '/api/v11/Service/list/organization', query: { organizationId, page: 1 } },
      { path: '/api/v11/Service/list/organization', query: { organizationId, page: 2 } },
    ]);
  });
});

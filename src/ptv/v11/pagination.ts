import type { PtvV11Client } from './client.js';
import type { V11IdNamePair, V11PagedList, V11ServiceWire } from './wireModel.js';

export const V11_LIST_BATCH_SIZE = 100;

export async function fetchIdWindow(
  client: PtvV11Client,
  listPath: string,
  start: number,
  count: number,
): Promise<{ ids: string[]; totalCountEstimate: number }> {
  if (count <= 0) return { ids: [], totalCountEstimate: 0 };

  const firstPageResult = await client.get<V11PagedList<V11IdNamePair>>(listPath, { page: 1 });
  const v11PageSize = firstPageResult.pageSize;
  const firstV11Page = Math.floor(start / v11PageSize) + 1;

  const ids: string[] = [];
  let v11Page = firstV11Page;
  let offsetInPage = start - (firstV11Page - 1) * v11PageSize;
  let pageResult = firstV11Page === 1 ? firstPageResult : undefined;

  while (ids.length < count) {
    if (!pageResult) {
      pageResult = await client.get<V11PagedList<V11IdNamePair>>(listPath, { page: v11Page });
    }

    const slice = pageResult.itemList.slice(offsetInPage, offsetInPage + (count - ids.length));
    ids.push(...slice.map((item) => item.id));

    if (v11Page >= pageResult.pageCount) break;
    v11Page += 1;
    offsetInPage = 0;
    pageResult = undefined;
  }

  return {
    ids,
    totalCountEstimate: firstPageResult.pageCount * firstPageResult.pageSize,
  };
}

/** PTV v11 limits /Service/list and sibling list endpoints to 100 GUIDs per request. */
export async function fetchListInBatches<T>(
  client: PtvV11Client,
  listPath: string,
  ids: string[],
): Promise<T[]> {
  const results: T[] = [];
  for (let offset = 0; offset < ids.length; offset += V11_LIST_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + V11_LIST_BATCH_SIZE);
    const wires = await client.get<T[]>(listPath, { guids: batch.join(',') });
    results.push(...wires);
  }
  return results;
}

/**
 * Fetch organization services through v11's dedicated, paginated endpoint.
 * This avoids constructing a huge /Service/list?guids=... URL for an
 * organization with many services.
 */
export async function fetchOrganizationServiceWindow(
  client: PtvV11Client,
  organizationId: string,
  start: number,
  count: number,
): Promise<{ items: V11ServiceWire[]; totalCountEstimate: number }> {
  if (count <= 0) return { items: [], totalCountEstimate: 0 };

  const firstPage = await client.get<V11PagedList<V11ServiceWire>>(
    '/api/v11/Service/list/organization',
    { organizationId, page: 1 },
  );
  const v11PageSize = firstPage.pageSize;
  const firstV11Page = Math.floor(start / v11PageSize) + 1;

  const items: V11ServiceWire[] = [];
  let v11Page = firstV11Page;
  let offsetInPage = start - (firstV11Page - 1) * v11PageSize;
  let pageResult = firstV11Page === 1 ? firstPage : undefined;

  while (items.length < count) {
    if (!pageResult) {
      pageResult = await client.get<V11PagedList<V11ServiceWire>>(
        '/api/v11/Service/list/organization',
        { organizationId, page: v11Page },
      );
    }

    const slice = pageResult.itemList.slice(offsetInPage, offsetInPage + (count - items.length));
    items.push(...slice);

    if (v11Page >= pageResult.pageCount) break;
    v11Page += 1;
    offsetInPage = 0;
    pageResult = undefined;
  }

  return {
    items,
    totalCountEstimate: firstPage.pageCount * firstPage.pageSize,
  };
}

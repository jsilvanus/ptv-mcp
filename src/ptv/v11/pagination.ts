import { isNotFound, mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from '../http.js';
import type { PtvV11Client } from './client.js';
import type {
  V11GeneralDescriptionWire,
  V11IdNamePair,
  V11PagedList,
  V11ServiceChannelWire,
  V11ServiceCollectionSummaryWire,
  V11ServiceCollectionWire,
  V11ServiceWire,
} from './wireModel.js';

/**
 * Every item of a paged v11 list endpoint, in page order. Page 1 gives
 * `pageCount`; the remaining pages are then fetched with bounded
 * concurrency rather than one after another.
 */
export async function fetchAllPages<T>(
  client: PtvV11Client,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T[]> {
  const firstPage = await client.get<V11PagedList<T>>(path, { ...query, page: 1 });
  const laterPages = Array.from(
    { length: Math.max(0, firstPage.pageCount - 1) },
    (_, index) => index + 2,
  );
  const rest = await mapWithConcurrency(laterPages, PAGE_FETCH_CONCURRENCY, async (page) => {
    const result = await client.get<V11PagedList<T>>(path, { ...query, page });
    return result.itemList ?? [];
  });
  return [...(firstPage.itemList ?? []), ...rest.flat()];
}

export async function fetchAllIdNamePairs(
  client: PtvV11Client,
  listPath: string,
): Promise<V11IdNamePair[]> {
  return fetchAllPages<V11IdNamePair>(client, listPath);
}

/**
 * Full records for `ids` from a v11 `.../list?guids=` endpoint, in batches
 * of 100, returned in the order of `ids` (ids PTV doesn't return are
 * dropped). PTV answers 404 when it finds none of a batch's ids; with
 * `notFoundAsEmpty` that batch is empty instead of an error.
 */
export async function fetchListByIds<T extends { id: string }>(
  client: PtvV11Client,
  listPath: string,
  ids: string[],
  { notFoundAsEmpty = false }: { notFoundAsEmpty?: boolean } = {},
): Promise<T[]> {
  const wires: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      wires.push(...(await client.get<T[]>(listPath, { guids: batch.join(',') })));
    } catch (err) {
      if (!notFoundAsEmpty || !isNotFound(err)) throw err;
    }
  }
  const byId = new Map(wires.map((wire) => [wire.id, wire]));
  return ids.map((id) => byId.get(id)).filter((wire): wire is T => wire !== undefined);
}

/**
 * v11's list endpoints (`GET /Service`, `/ServiceChannel`, etc.) page in
 * a server-fixed size — confirmed live (`pageSize: 1000` in every
 * response observed), with no query parameter to change it. Our own
 * `SearchParams.pageSize` can therefore ask for a window that doesn't
 * line up with v11's own pages, so this bridges the two: given the
 * domain-level [start, start+count) window, fetch as many of v11's fixed
 * pages as needed and slice out exactly the requested ids.
 */
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
  // Reuse the already-fetched first page instead of re-requesting it.
  let pageResult = firstV11Page === 1 ? firstPageResult : undefined;

  while (ids.length < count) {
    if (!pageResult) {
      pageResult = await client.get<V11PagedList<V11IdNamePair>>(listPath, { page: v11Page });
    }

    const slice = (pageResult.itemList ?? []).slice(
      offsetInPage,
      offsetInPage + (count - ids.length),
    );
    ids.push(...slice.map((item) => item.id));

    if (v11Page >= pageResult.pageCount) break;
    v11Page += 1;
    offsetInPage = 0;
    pageResult = undefined;
  }

  return {
    ids,
    // v11 exposes only pageCount (total pages), not a total item count —
    // this is an upper-bound estimate (the last page may be partial),
    // not an exact figure.
    totalCountEstimate: firstPageResult.pageCount * firstPageResult.pageSize,
  };
}

/**
 * v11 exposes an organization-specific service endpoint. It has a server-fixed
 * page size and accepts the organizationId directly, so use it instead of
 * enumerating the global Service id catalogue.
 */
export async function fetchOrganizationServiceWindow(
  client: PtvV11Client,
  organizationId: string,
): Promise<V11ServiceWire[]> {
  return fetchAllPages<V11ServiceWire>(client, '/api/v11/Service/list/organization', {
    organizationId,
  });
}

/**
 * v11 exposes a dedicated organization-filtered service-channel endpoint.
 * Its pagination is server-controlled, so enumerate the complete filtered
 * result and let the adapter apply the MCP page/pageSize window.
 */
export async function fetchOrganizationServiceChannelWindow(
  client: PtvV11Client,
  organizationId: string,
): Promise<V11ServiceChannelWire[]> {
  return fetchAllPages<V11ServiceChannelWire>(client, '/api/v11/ServiceChannel/list/organization', {
    organizationId,
  });
}

export async function fetchOrganizationServiceCollectionWindow(
  client: PtvV11Client,
  organizationId: string,
): Promise<V11ServiceCollectionWire[]> {
  const summaries = await fetchAllPages<V11ServiceCollectionSummaryWire>(
    client,
    '/api/v11/ServiceCollection/organization',
    { organizationId },
  );

  // The organization endpoint returns V10VmOpenApiServiceCollectionItem,
  // which has no publishingStatus/modified fields. Fetch the full v11
  // entity before handing it to the domain mapper (v11 has no
  // ServiceCollection/list?guids= endpoint).
  return mapWithConcurrency(summaries, PAGE_FETCH_CONCURRENCY, (summary) =>
    client.get<V11ServiceCollectionWire>(`/api/v11/ServiceCollection/${summary.id}`),
  );
}

/** v11 has no organization-filtered GeneralDescription endpoint; derive the set from the organization's services. */
export async function fetchOrganizationGeneralDescriptionWindow(
  client: PtvV11Client,
  organizationId: string,
): Promise<V11GeneralDescriptionWire[]> {
  const services = await fetchOrganizationServiceWindow(client, organizationId);
  const ids = [
    ...new Set(
      services
        .map((service) => service.generalDescriptionId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  return fetchListByIds<V11GeneralDescriptionWire>(client, '/api/v11/GeneralDescription/list', ids);
}

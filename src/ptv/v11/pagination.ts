import type { PtvV11Client } from './client.js';
import type { V11IdNamePair, V11PagedList } from './wireModel.js';

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

    const slice = pageResult.itemList.slice(offsetInPage, offsetInPage + (count - ids.length));
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

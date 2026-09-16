import type { PtvV11Client } from './client.js';
import type { V11IdNamePair, V11PagedList } from './wireModel.js';

/** v11 list endpoints use a server-fixed page size (observed as 1000). */
export async function fetchIdWindow(
  client: PtvV11Client,
  listPath: string,
  start: number,
  count: number,
): Promise<{ ids: string[]; pageCount: number }> {
  if (count <= 0) return { ids: [], pageCount: 0 };

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

  return { ids, pageCount: firstPageResult.pageCount };
}

/** PTV v11 bulk detail endpoints accept at most 100 GUIDs. */
export function chunkGuids(ids: string[], chunkSize = 100): string[][] {
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1');
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  return chunks;
}

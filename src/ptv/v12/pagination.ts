/** Reading v12's paginated responses, whose envelope field names vary. */

export function extractItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const object = raw as {
    items?: unknown[];
    content?: unknown[];
    data?: unknown[];
    results?: unknown[];
  };
  return object.items ?? object.content ?? object.data ?? object.results ?? [];
}

export function extractTotalCount(raw: unknown, fallback: number): number {
  if (!raw || typeof raw !== 'object') return fallback;
  // v12's paginated responses carry `totalItems` (see PaginatedType in
  // docs/ptv-api-documentation.json). Missing it made every catalogue scan
  // stop after the first page of 100.
  const object = raw as {
    totalItems?: number;
    totalCount?: number;
    totalElements?: number;
    total?: number;
  };
  return object.totalItems ?? object.totalCount ?? object.totalElements ?? object.total ?? fallback;
}

export function extractPageCount(raw: unknown, firstPageLength: number, pageSize: number): number {
  if (firstPageLength === 0) return 1;
  if (raw && typeof raw === 'object') {
    const totalPages = (raw as { totalPages?: unknown }).totalPages;
    if (typeof totalPages === 'number' && Number.isFinite(totalPages))
      return Math.max(1, totalPages);
  }
  return Math.max(1, Math.ceil(extractTotalCount(raw, firstPageLength) / pageSize));
}

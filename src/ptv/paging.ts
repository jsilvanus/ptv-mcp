import type { PaginatedResult, SearchParams } from './domain.js';

/** The `params.page` window of an already complete, already filtered list (defaults: page 1, 100 per page). */
export function paginate<T>(items: T[], params: SearchParams): PaginatedResult<T> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 100;
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalCount: items.length,
  };
}

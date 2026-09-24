import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { ptvCodeNameCache } from './schema/ptvCodeNameCache.js';
import type { PtvEnvironment } from '../ptv/adapter.js';
import type { CodeListEntry } from '../ptv/domain.js';
import type { CodeListKind, CodeNameStore, StoredCodeName } from '../ptv/v12/codeNameCache.js';

const SAVE_BATCH_SIZE = 500;

/**
 * Postgres-backed `CodeNameStore`. The table is global reference data
 * (no tenant_id, no RLS), so no `withContext` is needed.
 */
export class PtvCodeNameCacheService implements CodeNameStore {
  constructor(private readonly db: Database) {}

  async load(
    environment: PtvEnvironment,
    kind: CodeListKind,
    keys: string[],
  ): Promise<StoredCodeName[]> {
    if (keys.length === 0) return [];
    const rows = await this.db
      .select()
      .from(ptvCodeNameCache)
      .where(
        and(
          eq(ptvCodeNameCache.environment, environment),
          eq(ptvCodeNameCache.kind, kind),
          inArray(ptvCodeNameCache.key, keys),
          gt(ptvCodeNameCache.expiresAt, new Date()),
        ),
      );
    return rows.map((row) => ({
      environment,
      kind,
      key: row.key,
      entry: row.entry as CodeListEntry,
      expiresAt: row.expiresAt.getTime(),
    }));
  }

  async save(rows: StoredCodeName[]): Promise<void> {
    // The same key can appear twice in one flush; ON CONFLICT can't touch
    // a row twice in one statement, so keep only the last write per key.
    const unique = new Map<string, StoredCodeName>();
    for (const row of rows) unique.set(`${row.environment}\u0000${row.kind}\u0000${row.key}`, row);
    const values = [...unique.values()];
    const now = new Date();
    for (let i = 0; i < values.length; i += SAVE_BATCH_SIZE) {
      await this.db
        .insert(ptvCodeNameCache)
        .values(
          values.slice(i, i + SAVE_BATCH_SIZE).map((row) => ({
            environment: row.environment,
            kind: row.kind,
            key: row.key,
            entry: row.entry,
            fetchedAt: now,
            expiresAt: new Date(row.expiresAt),
          })),
        )
        .onConflictDoUpdate({
          target: [ptvCodeNameCache.environment, ptvCodeNameCache.kind, ptvCodeNameCache.key],
          set: {
            entry: sql`excluded.entry`,
            fetchedAt: sql`excluded.fetched_at`,
            expiresAt: sql`excluded.expires_at`,
          },
        });
    }
  }
}

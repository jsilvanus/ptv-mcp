import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { ptvEnvironmentEnum } from './enums.js';

/**
 * Persistent cache of PTV v12 classification names (service classes,
 * target groups, life events, industrial classes, ontology terms), keyed
 * by environment, vocabulary and code or URI. Backs the in-memory
 * `CodeNameCache` (src/ptv/v12/codeNameCache.ts) so resolved names
 * survive restarts and redeploys.
 *
 * Deliberately *not* tenant-scoped and without RLS: this is public PTV
 * reference data, identical for every tenant, and holds nothing tenant-
 * or user-specific.
 */
export const ptvCodeNameCache = pgTable(
  'ptv_code_name_cache',
  {
    environment: ptvEnvironmentEnum('environment').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    entry: jsonb('entry').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.environment, table.kind, table.key] })],
);

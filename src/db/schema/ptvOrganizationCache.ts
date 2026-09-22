import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';
import { ptvEnvironmentEnum } from './enums.js';

/**
 * Persistent cache of the PTV v11 organization catalogue.
 *
 * The cache is tenant-scoped because the catalogue is used through a
 * tenant/environment/API-version adapter context. The complete PTV wire
 * object is retained so later organization lookups do not need to refetch
 * /Organization/list.
 */
export const ptvOrganizationCache = pgTable(
  'ptv_organization_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    environment: ptvEnvironmentEnum('environment').notNull(),
    apiVersion: text('api_version').notNull(),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    organization: jsonb('organization').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    staleAt: timestamp('stale_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique().on(table.tenantId, table.environment, table.apiVersion, table.organizationId),
    index('ptv_organization_cache_search_idx').on(
      table.tenantId,
      table.environment,
      table.apiVersion,
      table.normalizedName,
    ),
    index('ptv_organization_cache_stale_idx').on(
      table.tenantId,
      table.environment,
      table.apiVersion,
      table.staleAt,
    ),
  ],
);

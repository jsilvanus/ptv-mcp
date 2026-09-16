import { boolean, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';
import { credentialScopeEnum, ptvEnvironmentEnum } from './enums.js';

/**
 * Governs which PtvAdapter PtvAdapterRegistry resolves for a given
 * tenant/environment, and what it's allowed to do. `apiVersion` is a free
 * string (not an enum) so adding a future v13 adapter is a new row and a
 * new adapter implementation, never a migration — see docs/plan.md's
 * "PTV-sovitinkerros" section.
 */
export const ptvAdapterConfigs = pgTable(
  'ptv_adapter_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    environment: ptvEnvironmentEnum('environment').notNull(),
    apiVersion: text('api_version').notNull(),
    authMode: text('auth_mode').notNull(),
    credentialScope: credentialScopeEnum('credential_scope').notNull(),
    supportsRead: boolean('supports_read').notNull().default(false),
    supportsWrite: boolean('supports_write').notNull().default(false),
    supportsDraftRead: boolean('supports_draft_read').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.tenantId, table.environment, table.apiVersion)],
);

import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';
import { ptvEnvironmentEnum } from './enums.js';

/**
 * Tenant-scoped PTV credentials — e.g. a v12 API key entered once by a
 * tenant admin for the whole organisation. NOT used for user-scoped
 * credentials like v11's OAuth token — those live in UserPtvConnection.
 * See docs/ptv-v11-notes.md's "Do we still need tenant_id" section.
 */
export const tenantEnvironments = pgTable(
  'tenant_environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    environment: ptvEnvironmentEnum('environment').notNull(),
    apiVersion: text('api_version').notNull(),
    /** Envelope-encrypted, shape depends on api_version's auth_mode (e.g. `{ apiKey }` for v12). */
    encryptedCredentials: jsonb('encrypted_credentials').notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.tenantId, table.environment, table.apiVersion)],
);

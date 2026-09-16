import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';
import { ptvEnvironmentEnum } from './enums.js';

/**
 * A user's personal PTV connection — e.g. v11's OAuth token, obtained via
 * the per-user consent link since palveluhallinta.suomi.fi has no
 * client_credentials path (confirmed in docs/ptv-v11-notes.md). Keyed by
 * user, not tenant: one connection is reusable across every tenant that
 * user is a Publisher for. Tenant/role authorization is still checked
 * separately at call time — see PtvAdapterRegistry.
 */
export const userPtvConnections = pgTable(
  'user_ptv_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apiVersion: text('api_version').notNull(),
    environment: ptvEnvironmentEnum('environment').notNull(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [unique().on(table.userId, table.apiVersion, table.environment)],
);

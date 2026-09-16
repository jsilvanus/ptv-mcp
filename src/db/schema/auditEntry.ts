import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';
import { users } from './user.js';
import { ptvEnvironmentEnum } from './enums.js';

/** Append-only audit trail. Never updated or deleted by application code. */
export const auditEntries = pgTable('audit_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  apiVersion: text('api_version'),
  environment: ptvEnvironmentEnum('environment'),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  prompt: text('prompt'),
  result: text('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

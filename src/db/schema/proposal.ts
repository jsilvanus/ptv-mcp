import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { proposalStatusEnum, ptvEnvironmentEnum } from './enums.js';
import { tenants } from './tenant.js';
import { users } from './user.js';

/**
 * Persisted proposal queue (Phase 8): Readers can queue changes; Editor+
 * users review and resolve them later. Stores the original change payload
 * and the queue-time diff for auditable review.
 */
export const proposals = pgTable('proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: text('service_id').notNull(),
  environment: ptvEnvironmentEnum('environment').notNull(),
  proposedByUserId: uuid('proposed_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  status: proposalStatusEnum('status').notNull().default('pending'),
  changes: jsonb('changes').notNull(),
  queuedDiff: jsonb('queued_diff').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

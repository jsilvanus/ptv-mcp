import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';
import { tenants } from './tenant.js';
import { membershipRoleEnum } from './enums.js';

/** A user's role within one tenant. A user may belong to many tenants (see docs/plan.md). */
export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tenantId] })],
);

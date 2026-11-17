import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    /**
     * Who granted the role: 'manual' (a tenant admin, the default) or 'oidc'
     * (a group at sign-in, src/oidc/groupGrants.ts). Only 'oidc' rows are
     * removed or changed by a group sync; a manual row is never touched.
     */
    source: text('source', { enum: ['manual', 'oidc'] })
      .notNull()
      .default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    check('memberships_source_check', sql`${table.source} IN ('manual', 'oidc')`),
  ],
);

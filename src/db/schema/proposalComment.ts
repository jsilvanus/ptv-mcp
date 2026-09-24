import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { proposals } from './proposal.js';
import { tenants } from './tenant.js';
import { users } from './user.js';

/**
 * Comments on a proposal (docs/roles-and-review-plan.md, step 3): any
 * Contributor+ can discuss a proposal before an Approver resolves it.
 * Tenant-scoped with RLS like `proposals`.
 */
export const proposalComments = pgTable(
  'proposal_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('proposal_comments_proposal_idx').on(table.proposalId, table.createdAt)],
);

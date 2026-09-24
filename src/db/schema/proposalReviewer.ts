import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { reviewDecisionEnum } from './enums.js';
import { proposals } from './proposal.js';
import { tenants } from './tenant.js';
import { users } from './user.js';

/**
 * Required reviewers of a proposal (docs/roles-and-review-plan.md, step 5):
 * approve_and_export / approve_and_apply wait until every one has
 * `approved`. Tenant-scoped with RLS like `proposals`.
 */
export const proposalReviewers = pgTable(
  'proposal_reviewers',
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
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decision: reviewDecisionEnum('decision').notNull().default('pending'),
    comment: text('comment'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    unique('proposal_reviewers_proposal_user_unique').on(table.proposalId, table.userId),
    index('proposal_reviewers_user_idx').on(table.tenantId, table.userId, table.decision),
  ],
);

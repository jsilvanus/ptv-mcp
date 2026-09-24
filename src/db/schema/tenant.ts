import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /**
   * Four-eyes rule (docs/roles-and-review-plan.md): nobody approves a
   * proposal they created, and the direct apply/export tools are off.
   * A one-person parish can switch it off.
   */
  requireFourEyes: boolean('require_four_eyes').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

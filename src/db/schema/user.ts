import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /** Null for an account created by OIDC sign-in (`OIDC_CREATE_USERS`): no password login until one is set by a reset. */
  passwordHash: text('password_hash'),
  /** Set once the user completes email verification (Phase 3 Stream A); null until then. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /** Login lockout (docs/plan.md's "kirjautumisyritysten rajoitus/lockout"). */
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

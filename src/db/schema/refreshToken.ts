import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';

/**
 * Opaque refresh tokens, stored as a SHA-256 hash (never the raw token —
 * the raw value is only ever returned to the client once, at issuance).
 * Rotation + denylist: refreshing marks the old row `revokedAt` and links
 * to its replacement; reusing an already-revoked token is rejected.
 *
 * Not RLS-scoped: like `users`/`tenants` (see
 * drizzle/0001_row_level_security.sql), a refresh/rotate lookup happens by
 * token hash *before* the caller's identity is otherwise established, so a
 * `current_setting('app.current_user_id')` gate isn't available yet at
 * query time. Access is controlled by query pattern (always by hash, never
 * a bare listing) instead.
 */
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedByTokenId: uuid('replaced_by_token_id'),
});

import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './user.js';

/**
 * Links an OpenID Connect identity (the IdP's `iss` + `sub`) to a local
 * user. Sign-in through the IdP (`src/oidc/`) looks the user up here first,
 * before any email matching. Not RLS-scoped, like `users`.
 */
export const oidcIdentities = pgTable(
  'oidc_identities',
  {
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.subject] }),
    index('oidc_identities_user_idx').on(table.userId),
  ],
);

/**
 * One row per started OIDC sign-in, keyed by SHA-256(state) and consumed
 * once by the callback. Holds the PKCE verifier and nonce server-side;
 * `oauthRequest` is the pending MCP authorization request (base64url, the
 * same encoding as the consent form's hidden `oauth` field) for purpose
 * `oauth`.
 */
export const oidcLoginStates = pgTable(
  'oidc_login_states',
  {
    stateHash: text('state_hash').primaryKey(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    purpose: text('purpose', { enum: ['web', 'oauth'] }).notNull(),
    oauthRequest: text('oauth_request'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('oidc_login_states_expires_idx').on(table.expiresAt),
    check('oidc_login_states_purpose_check', sql`${table.purpose} IN ('web', 'oauth')`),
  ],
);

/**
 * Hands a finished web-UI OIDC sign-in over to the SPA, which keeps its
 * session tokens in localStorage: the callback stores SHA-256(code) here
 * and redirects to `/login#oidc=<code>`; the SPA exchanges the code once
 * (`POST /oidc/session`) for the same session a password login returns.
 */
export const oidcWebHandoffs = pgTable('oidc_web_handoffs', {
  codeHash: text('code_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

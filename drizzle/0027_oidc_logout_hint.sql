-- RP-initiated sign-out (src/oidc/, src/routes/auth.ts): the IdP's ID token
-- from an OIDC web sign-in is kept so sign-out can send it as id_token_hint
-- to the provider's end-session endpoint. NULL for password sign-ins and for
-- rows written before this migration. Hand-written, like 0025: the drizzle
-- snapshot is not maintained for these migrations.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "oidc_id_token_hint" text;--> statement-breakpoint
ALTER TABLE "oidc_web_handoffs" ADD COLUMN IF NOT EXISTS "id_token_hint" text;

-- Group sync (OIDC_GROUP_SYNC, src/oidc/groupGrants.ts): who granted a
-- membership. Existing rows were all granted by hand, so they become
-- 'manual' and no sync ever touches them. Hand-written, like 0025 and 0027:
-- the drizzle snapshot is not maintained for these migrations.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_source_check" CHECK ("source" IN ('manual', 'oidc'));

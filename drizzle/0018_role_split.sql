-- Viewer < Contributor < Approver < Publisher < Tenant Admin
-- (docs/roles-and-review-plan.md). The old reader could create proposals,
-- so it becomes contributor; editor becomes approver. Rows keep their
-- meaning; viewer is new and read-only.
ALTER TYPE "public"."membership_role" RENAME VALUE 'reader' TO 'contributor';--> statement-breakpoint
ALTER TYPE "public"."membership_role" RENAME VALUE 'editor' TO 'approver';--> statement-breakpoint
ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'viewer' BEFORE 'contributor';

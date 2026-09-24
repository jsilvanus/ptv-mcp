-- Required reviewers and their sign-offs (docs/roles-and-review-plan.md,
-- step 5). Tenant-scoped with the same RLS policy as proposals, and an
-- explicit grant (see 0015).
CREATE TYPE "public"."review_decision" AS ENUM('pending', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TABLE "proposal_reviewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decision" "review_decision" DEFAULT 'pending' NOT NULL,
	"comment" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "proposal_reviewers_proposal_user_unique" UNIQUE("proposal_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "proposal_reviewers" ADD CONSTRAINT "proposal_reviewers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_reviewers" ADD CONSTRAINT "proposal_reviewers_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_reviewers" ADD CONSTRAINT "proposal_reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_reviewers" ADD CONSTRAINT "proposal_reviewers_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_reviewers_user_idx" ON "proposal_reviewers" USING btree ("tenant_id","user_id","decision");--> statement-breakpoint
ALTER TABLE "proposal_reviewers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proposal_reviewers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "proposal_reviewers"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE proposal_reviewers TO ptv_mcp_app;

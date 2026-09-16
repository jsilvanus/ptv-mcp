CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'applied', 'failed');--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" text NOT NULL,
	"environment" "ptv_environment" NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"changes" jsonb NOT NULL,
	"queued_diff" jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "proposals"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
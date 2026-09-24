-- Content review campaigns (docs/review-campaigns-plan.md): a full check of
-- an organisation's PTV content, one review item per service, channel and
-- organisation. Tenant-scoped with the same RLS policy as proposals, and an
-- explicit grant (see 0015).
CREATE TYPE "public"."review_campaign_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."review_target_kind" AS ENUM('organisation', 'service', 'channel');--> statement-breakpoint
CREATE TYPE "public"."review_item_status" AS ENUM('open', 'confirmed', 'changes_proposed');--> statement-breakpoint
CREATE TABLE "review_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "ptv_environment" NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"status" "review_campaign_status" DEFAULT 'open' NOT NULL,
	"due_date" date,
	"created_by_user_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"target_kind" "review_target_kind" NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text NOT NULL,
	"channel_type" text,
	"organization_id" text NOT NULL,
	"assignee_user_id" uuid,
	"status" "review_item_status" DEFAULT 'open' NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_items_campaign_target_unique" UNIQUE("campaign_id","target_kind","target_id")
);
--> statement-breakpoint
ALTER TABLE "review_campaigns" ADD CONSTRAINT "review_campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_campaigns" ADD CONSTRAINT "review_campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_campaign_id_review_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."review_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_items_assignee_idx" ON "review_items" USING btree ("tenant_id","assignee_user_id","status");--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "review_item_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_review_item_idx" ON "proposals" USING btree ("review_item_id");--> statement-breakpoint
ALTER TABLE "review_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_campaigns"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "review_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_items"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_campaigns TO ptv_mcp_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_items TO ptv_mcp_app;

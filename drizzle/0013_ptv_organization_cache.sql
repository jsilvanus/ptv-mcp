CREATE TABLE "ptv_organization_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "environment" "ptv_environment" NOT NULL,
  "api_version" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "organization" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "stale_at" timestamp with time zone NOT NULL,
  CONSTRAINT "ptv_organization_cache_tenant_id_environment_api_version_organization_id_unique"
    UNIQUE("tenant_id","environment","api_version","organization_id")
);
--> statement-breakpoint
ALTER TABLE "ptv_organization_cache"
  ADD CONSTRAINT "ptv_organization_cache_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ptv_organization_cache_search_idx"
  ON "ptv_organization_cache" ("tenant_id","environment","api_version","normalized_name");
--> statement-breakpoint
CREATE INDEX "ptv_organization_cache_stale_idx"
  ON "ptv_organization_cache" ("tenant_id","environment","api_version","stale_at");
--> statement-breakpoint
ALTER TABLE "ptv_organization_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ptv_organization_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ptv_organization_cache"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

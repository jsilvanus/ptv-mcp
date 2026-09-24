-- Global (not tenant-scoped) cache of PTV v12 classification names. Public
-- reference data identical for every tenant, so no tenant_id and no RLS.
CREATE TABLE "ptv_code_name_cache" (
  "environment" "ptv_environment" NOT NULL,
  "kind" text NOT NULL,
  "key" text NOT NULL,
  "entry" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "ptv_code_name_cache_environment_kind_key_pk" PRIMARY KEY("environment","kind","key")
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ptv_code_name_cache" TO ptv_mcp_app;

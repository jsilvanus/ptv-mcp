-- Four-eyes rule per tenant (docs/roles-and-review-plan.md, step 4), on by
-- default for existing tenants too.
ALTER TABLE "tenants" ADD COLUMN "require_four_eyes" boolean DEFAULT true NOT NULL;

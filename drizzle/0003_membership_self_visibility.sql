-- Phase 1 reopen (see EXECUTION_LOG.md): the original `memberships` RLS
-- policy only matched `tenant_id = app.current_tenant_id`, which makes
-- "which tenants do I belong to" (docs/plan.md's own Membership example —
-- a user belonging to several tenants) impossible to query at all: a user
-- doesn't know which tenant_id to set as context until they've already
-- read their memberships. Widen the policy to also allow a row through
-- when it's the caller's own membership row, regardless of tenant
-- context, while still requiring an exact tenant match (not just "any
-- row for this tenant") for the existing per-tenant admin case. Fails
-- closed exactly as before when neither setting is present.

DROP POLICY tenant_isolation ON memberships;

CREATE POLICY tenant_isolation ON memberships
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

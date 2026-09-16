-- Row-Level Security for tenant isolation (docs/plan.md: "sovellustason
-- suodatus ei riitä" — RLS is a second, DB-enforced layer under the
-- application's own tenant_id filtering, not a replacement for it).
--
-- The app connects as `ptv_mcp_app`, a non-superuser, NOBYPASSRLS role
-- distinct from the migration-owning role, so RLS actually restricts the
-- application's own queries and not just other roles. That role must
-- already exist before this migration runs — see
-- scripts/bootstrap-roles.sql, which a superuser runs once per cluster
-- (Postgres correctly refuses to let the migration role create it here:
-- CREATEROLE is a broad, dangerous privilege that the schema-owning role
-- has no other reason to hold). Per-request tenant scoping is set with
-- `SET LOCAL app.current_tenant_id = '<uuid>'` inside a transaction
-- (wired up in Phase 3's tenant resolver); with no setting present,
-- `current_setting(..., true)` returns NULL and every policy below
-- denies all rows — fail closed, not fail open.

GRANT USAGE ON SCHEMA public TO ptv_mcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ptv_mcp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ptv_mcp_app;

-- Tenant-scoped tables: gate on app.current_tenant_id.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE tenant_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_environments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_environments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE ptv_adapter_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ptv_adapter_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ptv_adapter_configs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- User-scoped, not tenant-scoped (docs/ptv-v11-notes.md: the v11 OAuth
-- credential is personal, reused across every tenant that user belongs
-- to) — gate on app.current_user_id instead.
ALTER TABLE user_ptv_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_ptv_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON user_ptv_connections
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- users and tenants themselves are not row-scoped by tenant_id (a user
-- can belong to many tenants; a tenant IS the boundary, not a row inside
-- one) — access to these is controlled by query patterns and the
-- memberships join, not row-level policies.

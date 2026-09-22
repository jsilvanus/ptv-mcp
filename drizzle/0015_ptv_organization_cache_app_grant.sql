-- The cache table is tenant-scoped and must be readable/writable by the
-- application role. 0013 relied on the default privileges from 0001,
-- which is unsafe when migrations are run by a role with different default
-- privileges. Repair existing installations explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ptv_organization_cache TO ptv_mcp_app;

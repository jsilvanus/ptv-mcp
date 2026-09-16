-- One-time, per-cluster bootstrap. Run once by a superuser (or a role
-- with CREATEROLE) before the first `npm run db:migrate` against a new
-- Postgres cluster/database — never as part of the regular migration
-- chain, which runs with the least-privilege, non-CREATEROLE
-- `ptv_mcp` (or equivalent) schema-owning role.
--
-- Local dev: `sudo -u postgres psql -d ptv_mcp_dev -f scripts/bootstrap-roles.sql`
-- Docker Compose: mounted into postgres's docker-entrypoint-initdb.d, so
-- the official postgres image runs it automatically as the superuser on
-- first container start (see docker-compose.yml).
--
-- Change the password in every environment beyond local dev — this one
-- is a placeholder for docker-compose/local use only, matching
-- .env.example's DATABASE_URL convention for the migration role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ptv_mcp_app') THEN
    CREATE ROLE ptv_mcp_app LOGIN PASSWORD 'ptv_mcp_app_dev' NOBYPASSRLS;
  END IF;
END
$$;

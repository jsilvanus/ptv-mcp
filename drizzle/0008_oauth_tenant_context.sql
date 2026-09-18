ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_tenant_idx
  ON oauth_authorization_codes(tenant_id);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_tenant_idx
  ON oauth_refresh_tokens(tenant_id);

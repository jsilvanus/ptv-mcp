-- CIMD client IDs are HTTPS URLs and do not have rows in oauth_clients.
-- Authorization codes and refresh tokens must therefore retain the client_id
-- as an opaque identifier without requiring a foreign-key registration row.
ALTER TABLE oauth_authorization_codes
  DROP CONSTRAINT IF EXISTS oauth_authorization_codes_client_id_fkey;

ALTER TABLE oauth_refresh_tokens
  DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_client_id_fkey;

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS api_version text;

ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS api_version text;

UPDATE oauth_authorization_codes
SET environment = COALESCE(environment, 'production'),
    api_version = COALESCE(api_version, 'v11')
WHERE environment IS NULL OR api_version IS NULL;

UPDATE oauth_refresh_tokens
SET environment = COALESCE(environment, 'production'),
    api_version = COALESCE(api_version, 'v11')
WHERE environment IS NULL OR api_version IS NULL;

ALTER TABLE oauth_authorization_codes
  ALTER COLUMN environment SET NOT NULL,
  ALTER COLUMN api_version SET NOT NULL;

ALTER TABLE oauth_refresh_tokens
  ALTER COLUMN environment SET NOT NULL,
  ALTER COLUMN api_version SET NOT NULL;

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS read_api_version text,
  ADD COLUMN IF NOT EXISTS write_api_version text;

ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS read_api_version text,
  ADD COLUMN IF NOT EXISTS write_api_version text;

UPDATE oauth_authorization_codes
SET read_api_version = COALESCE(read_api_version, api_version, 'v11'),
    write_api_version = COALESCE(write_api_version, api_version, 'v11')
WHERE read_api_version IS NULL OR write_api_version IS NULL;

UPDATE oauth_refresh_tokens
SET read_api_version = COALESCE(read_api_version, api_version, 'v11'),
    write_api_version = COALESCE(write_api_version, api_version, 'v11')
WHERE read_api_version IS NULL OR write_api_version IS NULL;

ALTER TABLE oauth_authorization_codes
  ALTER COLUMN read_api_version SET NOT NULL,
  ALTER COLUMN write_api_version SET NOT NULL;

ALTER TABLE oauth_refresh_tokens
  ALTER COLUMN read_api_version SET NOT NULL,
  ALTER COLUMN write_api_version SET NOT NULL;

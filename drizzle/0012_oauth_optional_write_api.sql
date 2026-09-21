ALTER TABLE oauth_authorization_codes
  ALTER COLUMN write_api_version DROP NOT NULL;

ALTER TABLE oauth_refresh_tokens
  ALTER COLUMN write_api_version DROP NOT NULL;

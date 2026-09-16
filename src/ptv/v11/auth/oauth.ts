import { randomUUID } from 'crypto';

/**
 * OAuth2 authorization URL builder for PTV v11 implicit grant flow.
 *
 * IMPORTANT: PTV v11's OIDC discovery document returns an empty token_endpoint,
 * meaning there is no server-side token exchange. The implicit flow is the only
 * viable mechanism — the access token comes back directly in the browser redirect's
 * URL fragment (#access_token=...), never sent to our backend automatically.
 *
 * A small client-side callback page must capture window.location.hash and POST it
 * to our backend, where parseCallbackFragment can extract the token.
 */

/** Configuration options for building an OAuth2 authorization URL. */
export interface BuildAuthorizationUrlOptions {
  /** OAuth2 client ID registered with PTV */
  clientId: string;
  /** Where PTV should redirect the browser after user consent (must be registered with PTV) */
  redirectUri: string;
  /** OAuth2 scope to request. Unconfirmed in practice; defaults to 'dataEventRecords' from v11's spec. */
  scope?: string;
  /** CSRF protection nonce — caller generates and verifies. */
  state: string;
}

/**
 * Builds a full OAuth2 authorization URL for PTV v11's implicit grant flow.
 *
 * @param options Configuration
 * @returns The full authorization URL for the user's browser
 */
export function buildAuthorizationUrl(options: BuildAuthorizationUrlOptions): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'token',
    scope: options.scope ?? 'dataEventRecords',
    state: options.state,
  });

  return `https://palveluhallinta.suomi.fi/api/auth/connect/authorize?${params.toString()}`;
}

/**
 * Generates a cryptographically random state parameter for CSRF protection.
 *
 * @returns A URL-safe random string
 */
export function generateState(): string {
  // Use a UUID for simplicity and guaranteed uniqueness; randomBytes(32) works too
  return randomUUID();
}

/** Result of successfully parsing an OAuth2 authorization response. */
export interface ParseCallbackFragmentSuccess {
  accessToken: string;
  expiresInSeconds: number;
  state?: string;
}

/** Result of parsing an OAuth2 error response. */
export interface ParseCallbackFragmentError {
  error: string;
  errorDescription?: string;
}

/**
 * Parses the URL fragment from PTV's OAuth2 redirect into the caller's callback page.
 *
 * The fragment is the part after `#` in the browser location, e.g.:
 * - Success: `access_token=xyz&token_type=Bearer&expires_in=3600&state=abc`
 * - Error: `error=access_denied&error_description=User%20denied%20access`
 *
 * This function is typically called from a small client-side callback page that
 * captures window.location.hash and POSTs it to the backend.
 *
 * @param fragment The URL fragment string (with or without leading `#`)
 * @returns Parsed result; throws only on unrecoverable errors
 */
export function parseCallbackFragment(
  fragment: string,
): ParseCallbackFragmentSuccess | ParseCallbackFragmentError {
  // Strip leading # if present
  const clean = fragment.startsWith('#') ? fragment.slice(1) : fragment;

  // Empty fragment is an error (ambiguous, but we treat it as such)
  if (!clean.trim()) {
    return { error: 'empty_fragment', errorDescription: 'No data in URL fragment' };
  }

  const params = new URLSearchParams(clean);

  // Check for OAuth error response first
  const error = params.get('error');
  if (error) {
    const errorDescription = params.get('error_description');
    const result: ParseCallbackFragmentError = {
      error,
    };
    if (errorDescription) {
      result.errorDescription = errorDescription;
    }
    return result;
  }

  // Expect success case: access_token + expires_in
  const accessToken = params.get('access_token');
  const expiresInStr = params.get('expires_in');

  if (!accessToken || !expiresInStr) {
    return {
      error: 'missing_required_fields',
      errorDescription: 'access_token or expires_in missing from fragment',
    };
  }

  const expiresInSeconds = parseInt(expiresInStr, 10);
  if (isNaN(expiresInSeconds) || expiresInSeconds < 0) {
    return {
      error: 'invalid_expires_in',
      errorDescription: `expires_in must be a non-negative integer, got "${expiresInStr}"`,
    };
  }

  const result: ParseCallbackFragmentSuccess = {
    accessToken,
    expiresInSeconds,
  };
  const state = params.get('state');
  if (state) {
    result.state = state;
  }
  return result;
}

/**
 * OAuth2 token introspection and revocation for PTV v11.
 *
 * IMPORTANT: PTV's actual auth mechanism for the introspection and revocation
 * endpoints is unconfirmed. This implementation uses the standard RFC 7662
 * (introspection) and RFC 7009 (revocation) patterns — HTTP Basic auth with
 * clientId:clientSecret. If PTV uses a different mechanism (e.g., no auth,
 * bearer token, custom header, or different body parameters), this will need
 * to be updated after real-world testing. The code is written to be easily
 * swappable if needed.
 */

/**
 * Result of successfully introspecting a token per RFC 7662.
 *
 * The 'active' field is the only guaranteed response field; others are present
 * if the token is active and issuer has returned them.
 */
export interface IntrospectionResult {
  /** Whether the token is currently active/valid */
  active: boolean;
  /** Subject (user ID) the token was issued to, if available */
  sub?: string;
  /** Scope(s) granted by the token, if available */
  scope?: string;
  /** Expiration time (seconds since epoch), if available */
  exp?: number;
  /** Any additional fields the issuer returns */
  [key: string]: unknown;
}

/** Options for introspecting a token. */
export interface IntrospectTokenOptions {
  /** Introspection endpoint; defaults to PTV's production endpoint */
  introspectionEndpoint?: string;
  /** OAuth2 client ID registered with PTV */
  clientId: string;
  /** OAuth2 client secret registered with PTV; NOT to be sent to frontend */
  clientSecret: string;
  /** Override fetch implementation (for testing) */
  fetchImpl?: typeof fetch;
}

/**
 * Introspects a token to check its validity and extract claims.
 *
 * Calls the introspection endpoint with HTTP Basic auth per RFC 7662.
 * The token is sent in the request body, not exposed in headers or logs.
 *
 * @param token The access token to introspect
 * @param options Configuration
 * @returns Token introspection result
 * @throws If the HTTP request fails (non-2xx status), throws with status code and generic message
 */
export async function introspectToken(
  token: string,
  options: IntrospectTokenOptions,
): Promise<IntrospectionResult> {
  const endpoint =
    options.introspectionEndpoint ?? 'https://palveluhallinta.suomi.fi/api/auth/introspect';
  const fetchImpl = options.fetchImpl ?? fetch;

  // Build HTTP Basic auth header (RFC 7662)
  const credentials = `${options.clientId}:${options.clientSecret}`;
  const encodedCredentials = Buffer.from(credentials).toString('base64');

  const body = new URLSearchParams({ token });

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${encodedCredentials}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`PTV introspection request failed with status ${response.status}`);
  }

  return (await response.json()) as IntrospectionResult;
}

/** Options for revoking a token. */
export interface RevokeTokenOptions {
  /** Revocation endpoint; defaults to PTV's production endpoint */
  revocationEndpoint?: string;
  /** OAuth2 client ID registered with PTV */
  clientId: string;
  /** OAuth2 client secret registered with PTV; NOT to be sent to frontend */
  clientSecret: string;
  /** Override fetch implementation (for testing) */
  fetchImpl?: typeof fetch;
}

/**
 * Revokes a token to immediately invalidate it.
 *
 * Calls the revocation endpoint with HTTP Basic auth per RFC 7009.
 * The token is sent in the request body, not exposed in headers or logs.
 *
 * Per RFC 7009, the endpoint returns 200 OK whether the token was actually
 * revoked or was already invalid, so errors only result from HTTP failures.
 *
 * @param token The access token to revoke
 * @param options Configuration
 * @throws If the HTTP request fails (non-2xx status), throws with status code and generic message
 */
export async function revokeToken(token: string, options: RevokeTokenOptions): Promise<void> {
  const endpoint = options.revocationEndpoint ?? 'https://palveluhallinta.suomi.fi/api/auth/revoke';
  const fetchImpl = options.fetchImpl ?? fetch;

  // Build HTTP Basic auth header (RFC 7009)
  const credentials = `${options.clientId}:${options.clientSecret}`;
  const encodedCredentials = Buffer.from(credentials).toString('base64');

  const body = new URLSearchParams({ token });

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${encodedCredentials}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`PTV revocation request failed with status ${response.status}`);
  }
}

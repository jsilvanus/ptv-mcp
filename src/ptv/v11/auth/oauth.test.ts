import { describe, expect, it, vi } from 'vitest';
import { buildAuthorizationUrl, generateState, parseCallbackFragment } from './oauth.js';
import { introspectToken, revokeToken } from './introspection.js';

describe('OAuth2 Flow — buildAuthorizationUrl', () => {
  it('produces a URL with correct host and path', () => {
    const url = buildAuthorizationUrl({
      clientId: 'test-client',
      redirectUri: 'http://localhost:3000/callback',
      state: 'state123',
    });

    expect(url).toContain('https://palveluhallinta.suomi.fi/api/auth/connect/authorize?');
  });

  it('includes all required query parameters', () => {
    const url = buildAuthorizationUrl({
      clientId: 'my-client',
      redirectUri: 'https://example.com/oauth/callback',
      scope: 'dataEventRecords',
      state: 'abc-state',
    });

    const urlObj = new URL(url);
    expect(urlObj.searchParams.get('client_id')).toBe('my-client');
    expect(urlObj.searchParams.get('redirect_uri')).toBe('https://example.com/oauth/callback');
    expect(urlObj.searchParams.get('response_type')).toBe('token');
    expect(urlObj.searchParams.get('scope')).toBe('dataEventRecords');
    expect(urlObj.searchParams.get('state')).toBe('abc-state');
  });

  it('encodes special characters in redirectUri', () => {
    const redirectUri = 'http://localhost:3000/callback?env=test&return=/dashboard';
    const url = buildAuthorizationUrl({
      clientId: 'client',
      redirectUri,
      state: 'state',
    });

    const urlObj = new URL(url);
    // The redirectUri should be properly percent-encoded in the query param
    expect(urlObj.searchParams.get('redirect_uri')).toBe(redirectUri);
  });

  it('uses default scope when not provided', () => {
    const url = buildAuthorizationUrl({
      clientId: 'client',
      redirectUri: 'http://localhost:3000',
      state: 'state123',
    });

    const urlObj = new URL(url);
    expect(urlObj.searchParams.get('scope')).toBe('dataEventRecords');
  });

  it('respects custom scope when provided', () => {
    const url = buildAuthorizationUrl({
      clientId: 'client',
      redirectUri: 'http://localhost:3000',
      scope: 'custom-scope another-scope',
      state: 'state123',
    });

    const urlObj = new URL(url);
    expect(urlObj.searchParams.get('scope')).toBe('custom-scope another-scope');
  });
});

describe('OAuth2 Flow — generateState', () => {
  it('returns a non-empty string', () => {
    const state = generateState();
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
  });

  it('returns different values on repeated calls', () => {
    const state1 = generateState();
    const state2 = generateState();
    const state3 = generateState();

    expect(state1).not.toBe(state2);
    expect(state2).not.toBe(state3);
    expect(state1).not.toBe(state3);
  });

  it('produces non-trivial length strings', () => {
    const state = generateState();
    // UUID is 36 chars (including hyphens), we expect at least 20
    expect(state.length).toBeGreaterThanOrEqual(20);
  });

  it('produces URL-safe strings', () => {
    const state = generateState();
    // Ensure it's safe to pass as a URL parameter (no special chars that need encoding)
    // UUIDs are always URL-safe
    const encoded = encodeURIComponent(state);
    // After encoding, it should look the same (no special chars)
    expect(encoded).toBe(state);
  });
});

describe('OAuth2 Flow — parseCallbackFragment', () => {
  it('parses a successful callback fragment with all fields', () => {
    const fragment = 'access_token=abc123&token_type=Bearer&expires_in=3600&state=xyz789';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      accessToken: 'abc123',
      expiresInSeconds: 3600,
      state: 'xyz789',
    });
  });

  it('parses fragment without leading hash', () => {
    const fragment = 'access_token=token123&expires_in=7200';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      accessToken: 'token123',
      expiresInSeconds: 7200,
      state: undefined,
    });
  });

  it('parses fragment with leading hash', () => {
    const fragment = '#access_token=token456&expires_in=1800';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      accessToken: 'token456',
      expiresInSeconds: 1800,
      state: undefined,
    });
  });

  it('parses OAuth error response', () => {
    const fragment = 'error=access_denied&error_description=User%20denied%20access';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      error: 'access_denied',
      errorDescription: 'User denied access',
    });
  });

  it('parses error response with just error code', () => {
    const fragment = 'error=invalid_request';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      error: 'invalid_request',
      errorDescription: undefined,
    });
  });

  it('handles empty fragment gracefully', () => {
    const result = parseCallbackFragment('');
    expect(result).toEqual({
      error: 'empty_fragment',
      errorDescription: 'No data in URL fragment',
    });
  });

  it('handles fragment with only hash', () => {
    const result = parseCallbackFragment('#');
    expect(result).toEqual({
      error: 'empty_fragment',
      errorDescription: 'No data in URL fragment',
    });
  });

  it('handles whitespace-only fragment', () => {
    const result = parseCallbackFragment('   ');
    expect(result).toEqual({
      error: 'empty_fragment',
      errorDescription: 'No data in URL fragment',
    });
  });

  it('returns error when access_token is missing', () => {
    const fragment = 'token_type=Bearer&expires_in=3600';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      error: 'missing_required_fields',
      errorDescription: 'access_token or expires_in missing from fragment',
    });
  });

  it('returns error when expires_in is missing', () => {
    const fragment = 'access_token=token123&token_type=Bearer';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      error: 'missing_required_fields',
      errorDescription: 'access_token or expires_in missing from fragment',
    });
  });

  it('returns error when expires_in is not a valid integer', () => {
    const fragment = 'access_token=token123&expires_in=not_a_number';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      error: 'invalid_expires_in',
      errorDescription: 'expires_in must be a non-negative integer, got "not_a_number"',
    });
  });

  it('returns error when expires_in is negative', () => {
    const fragment = 'access_token=token123&expires_in=-100';
    const result = parseCallbackFragment(fragment);

    expect(result).toEqual({
      error: 'invalid_expires_in',
      errorDescription: 'expires_in must be a non-negative integer, got "-100"',
    });
  });

  it('parses fragment with URL-encoded special characters in token', () => {
    const fragment = 'access_token=abc%2B123%2F456&expires_in=3600';
    const result = parseCallbackFragment(fragment);

    // URLSearchParams automatically decodes
    expect(result).toEqual({
      accessToken: 'abc+123/456',
      expiresInSeconds: 3600,
      state: undefined,
    });
  });
});

describe('OAuth2 — introspectToken', () => {
  it('POSTs to introspection endpoint with correct headers and body', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true, sub: 'user123', scope: 'dataEventRecords' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await introspectToken('test-token', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl: mockFetch,
    });

    expect(result).toEqual({
      active: true,
      sub: 'user123',
      scope: 'dataEventRecords',
    });

    // Verify the request was made correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe('https://palveluhallinta.suomi.fi/api/auth/introspect');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    // Verify Basic auth header is present
    const authHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Basic /);
    // Basic auth should be base64-encoded clientId:clientSecret
    const credentials = Buffer.from(authHeader!.slice(6), 'base64').toString();
    expect(credentials).toBe('client-id:client-secret');

    // Verify body contains token
    expect(init?.body).toBe('token=test-token');
  });

  it('uses custom introspection endpoint when provided', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: false }), { status: 200 }),
    );

    await introspectToken('token', {
      introspectionEndpoint: 'https://custom.example.com/introspect',
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: mockFetch,
    });

    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url] = call!;
    expect(url).toBe('https://custom.example.com/introspect');
  });

  it('throws error on non-2xx response', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(
      introspectToken('token', {
        clientId: 'client',
        clientSecret: 'secret',
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow('PTV introspection request failed with status 401');
  });

  it('returns full JSON response including optional fields', async () => {
    const mockFetch = vi.fn();
    const responseData = {
      active: true,
      sub: 'user-id',
      scope: 'scope1 scope2',
      exp: 1726513200,
      iat: 1726509600,
      client_id: 'my-client',
      custom_field: 'custom_value',
    };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(responseData), { status: 200 }));

    const result = await introspectToken('token', {
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: mockFetch,
    });

    expect(result).toEqual(responseData);
  });
});

describe('OAuth2 — revokeToken', () => {
  it('POSTs to revocation endpoint with correct headers and body', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

    await revokeToken('test-token', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl: mockFetch,
    });

    // Verify the request was made correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe('https://palveluhallinta.suomi.fi/api/auth/revoke');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    // Verify Basic auth header
    const authHeader = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Basic /);
    const credentials = Buffer.from(authHeader!.slice(6), 'base64').toString();
    expect(credentials).toBe('client-id:client-secret');

    // Verify body contains token
    expect(init?.body).toBe('token=test-token');
  });

  it('uses custom revocation endpoint when provided', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

    await revokeToken('token', {
      revocationEndpoint: 'https://custom.example.com/revoke',
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: mockFetch,
    });

    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url] = call!;
    expect(url).toBe('https://custom.example.com/revoke');
  });

  it('throws error on non-2xx response', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    await expect(
      revokeToken('token', {
        clientId: 'client',
        clientSecret: 'secret',
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow('PTV revocation request failed with status 500');
  });

  it('returns void on success', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

    const result = await revokeToken('token', {
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: mockFetch,
    });

    expect(result).toBeUndefined();
  });
});

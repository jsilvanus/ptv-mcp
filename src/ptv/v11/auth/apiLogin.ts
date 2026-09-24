import type { PtvEnvironment } from '../../adapter.js';

/**
 * PTV v11 IN-API authentication: an organisation's API user exchanges
 * username + password for a bearer token. Per DVV's IN-integration docs
 * (kehittajille.suomi.fi → "Lisätietoa IN-integraation toteuttajalle"),
 * the two environments differ in URL, request and response shape:
 *
 * - production: POST palveluhallinta.suomi.fi/api/auth/api-login
 *   `{username, password, apiUserOrganisation?}` → `{serviceToken}`
 * - test ("asiakastestiympäristö"): POST palvelutietovaranto.trn.suomi.fi/api/auth/api-login
 *   `{username, password}`; a test token is bound to one organisation and
 *   has no apiUserOrganisation. DVV's page documents `/connect/token`
 *   instead, but that endpoint expects a form body and answers our JSON
 *   with HTTP 500 (verified 2026-09-24); `/api/auth/api-login` accepts JSON
 *   there too. The response field may be `serviceToken` or `ptvToken`.
 *
 * See docs/ptv-v11-notes.md and docs/ptv-test-environment.md.
 */
export const V11_API_LOGIN_URLS: Record<PtvEnvironment, string> = {
  production: 'https://palveluhallinta.suomi.fi/api/auth/api-login',
  test: 'https://palvelutietovaranto.trn.suomi.fi/api/auth/api-login',
};

export interface V11ApiUserCredentials {
  username: string;
  password: string;
  /** Palveluhallinta organisation id; production only, for API users linked to several organisations. */
  apiUserOrganisation?: string;
  /** PTV organisation this API user writes to, as chosen by the tenant admin (informational). */
  organisationId?: string;
}

export interface V11ApiToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export class V11ApiLoginError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'V11ApiLoginError';
  }
}

/** Used when a token carries no readable `exp` claim. */
const FALLBACK_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
/** Refresh this long before expiry so a token never lapses mid-request. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Parse V11ApiUserCredentials out of TenantEnvironment's decrypted blob,
 * or undefined when the blob isn't an API-user credential.
 */
export function parseV11ApiUserCredentials(
  credentials: Record<string, unknown> | undefined,
): V11ApiUserCredentials | undefined {
  const username = credentials?.username;
  const password = credentials?.password;
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return undefined;
  }
  const organisation = credentials?.apiUserOrganisation;
  const organisationId = credentials?.organisationId;
  return {
    username,
    password,
    ...(typeof organisation === 'string' && organisation
      ? { apiUserOrganisation: organisation }
      : {}),
    ...(typeof organisationId === 'string' && organisationId ? { organisationId } : {}),
  };
}

interface LoginAttempt {
  url: string;
  form: boolean;
}

/**
 * Test environment: DVV documents `/connect/token`, which parses a form
 * body (JSON makes it answer 500); `/api/auth/api-login` takes JSON like
 * production. Both are tried, documented one first.
 */
const LOGIN_ATTEMPTS: Record<PtvEnvironment, LoginAttempt[]> = {
  production: [{ url: V11_API_LOGIN_URLS.production, form: false }],
  test: [
    { url: 'https://palvelutietovaranto.trn.suomi.fi/connect/token', form: true },
    { url: V11_API_LOGIN_URLS.test, form: false },
  ],
};

export async function fetchV11ApiToken(
  environment: PtvEnvironment,
  credentials: V11ApiUserCredentials,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<V11ApiToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const fields: Record<string, string> = {
    username: credentials.username,
    password: credentials.password,
  };
  if (environment === 'production' && credentials.apiUserOrganisation) {
    fields.apiUserOrganisation = credentials.apiUserOrganisation;
  }

  const failures: string[] = [];
  let status: number | undefined;
  for (const attempt of LOGIN_ATTEMPTS[environment]) {
    const path = new URL(attempt.url).pathname;
    let response: Response;
    try {
      response = await fetchImpl(attempt.url, {
        method: 'POST',
        headers: {
          'Content-Type': attempt.form ? 'application/x-www-form-urlencoded' : 'application/json',
          Accept: 'application/json',
        },
        body: attempt.form ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
      });
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const payload = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;
    if (!response.ok) {
      status ??= response.status;
      // PTV's own error `message` (e.g. "credentails are wrong") says why; it
      // names the user, never the password. Nothing else is echoed.
      const reason =
        typeof payload?.message === 'string'
          ? `: ${payload.message.replaceAll(credentials.password, '***')}`
          : '';
      failures.push(`${path} HTTP ${response.status}${reason}`);
      continue;
    }
    const token =
      payload?.serviceToken ?? payload?.ptvToken ?? payload?.access_token ?? payload?.token;
    if (typeof token !== 'string' || !token) {
      // Field names only, never values.
      failures.push(
        `${path} returned no token (fields: ${Object.keys(payload ?? {}).join(', ') || 'none'})`,
      );
      continue;
    }
    return { token, expiresAt: jwtExpiry(token) ?? now() + FALLBACK_TOKEN_LIFETIME_MS };
  }
  throw new V11ApiLoginError(
    `PTV ${environment} API login was rejected (${failures.join('; ')})`,
    status,
  );
}

/** `exp` of a JWT in epoch milliseconds, without verifying the signature. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Caches API-user tokens per (environment, username, organisation) until
 * shortly before expiry, and shares one in-flight login between
 * concurrent callers. Adapter instances are per request, so the app
 * shares one instance process-wide.
 */
export class V11ApiTokenCache {
  private readonly tokens = new Map<string, V11ApiToken>();
  private readonly inFlight = new Map<string, Promise<V11ApiToken>>();

  constructor(private readonly options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {}

  async getToken(environment: PtvEnvironment, credentials: V11ApiUserCredentials): Promise<string> {
    const now = this.options.now ?? Date.now;
    // The password is part of the key so a changed password never reuses
    // a token obtained with the old one.
    const key = [
      environment,
      credentials.username,
      credentials.apiUserOrganisation ?? '',
      credentials.password,
    ].join('\u0000');
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = fetchV11ApiToken(environment, credentials, this.options).finally(() =>
        this.inFlight.delete(key),
      );
      this.inFlight.set(key, pending);
    }
    const fresh = await pending;
    this.tokens.set(key, fresh);
    return fresh.token;
  }

  /** Drop a token PTV rejected, so the next call logs in again. */
  invalidate(environment: PtvEnvironment, credentials: V11ApiUserCredentials): void {
    for (const key of this.tokens.keys()) {
      if (key.startsWith(`${environment}\u0000${credentials.username}\u0000`))
        this.tokens.delete(key);
    }
  }
}

export const sharedV11ApiTokenCache = new V11ApiTokenCache();

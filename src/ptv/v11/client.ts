import type { PtvEnvironment } from '../adapter.js';

/**
 * Base URLs confirmed live 2026-09-16 (see docs/ptv-v11-notes.md) — both
 * hosts served identical /api/v11/CodeList/GetLanguageCodes responses.
 * Not documented in v11's own swagger.json (which only lists the
 * production host), so this mapping is this codebase's own source of
 * truth for the test environment's base URL.
 */
export const V11_BASE_URLS: Record<PtvEnvironment, string> = {
  production: 'https://api.palvelutietovaranto.suomi.fi',
  test: 'https://api.palvelutietovaranto.trn.suomi.fi',
};

export interface V11ClientOptions {
  environment: PtvEnvironment;
  /** Bearer access token from the user's PTV connection. Omit for v11's unauthenticated public reads. */
  accessToken?: string;
  /**
   * Organisation API-user token source (see auth/apiLogin.ts), used for
   * POST/PUT only: public GETs stay anonymous, since v11 500s an
   * otherwise-public GET that carries a bad token.
   */
  writeTokenProvider?: WriteTokenProvider;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export interface WriteTokenProvider {
  getToken(): Promise<string>;
  /** Called when PTV answers 401, before one retry with a fresh token. */
  invalidate(): void;
}

export class PtvV11ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'PtvV11ApiError';
  }
}

/**
 * Thin HTTP client for PTV v11's OUT (read) and IN (write) interfaces.
 * Retries on transient failures with exponential backoff + jitter,
 * honoring Retry-After when present — v11's spec documents no rate
 * limits, so this is a defensive default rather than a response to a
 * documented contract (see docs/plan.md's note on this).
 */
export class PtvV11Client {
  private readonly baseUrl: string;
  private readonly accessToken: string | undefined;
  private readonly writeTokenProvider: WriteTokenProvider | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(options: V11ClientOptions) {
    this.baseUrl = V11_BASE_URLS[options.environment];
    this.accessToken = options.accessToken;
    this.writeTokenProvider = options.writeTokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  /** Whether an organisation API user is configured, i.e. `getRestricted` can authenticate. */
  get canAuthenticate(): boolean {
    return this.writeTokenProvider !== undefined;
  }

  /**
   * GET a restricted endpoint (e.g. `Service/active/{id}`) with the API-user
   * token. Only for endpoints that require it: v11 500s a public GET that
   * carries a token it doesn't like.
   */
  async getRestricted<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined, undefined, true);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, undefined, body);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
    restricted = false,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const tokenProvider = method === 'GET' && !restricted ? undefined : this.writeTokenProvider;
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let lastError: unknown;
    let reauthenticated = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Outside the try: a failed login is not a transient network error.
      if (tokenProvider) headers.Authorization = `Bearer ${await tokenProvider.getToken()}`;
      try {
        const response = await this.fetchImpl(url, init);

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }

        if (response.status === 401 && tokenProvider && !reauthenticated) {
          reauthenticated = true;
          tokenProvider.invalidate();
          attempt--;
          continue;
        }

        if (!isRetryable(response.status) || attempt === this.maxRetries) {
          const text = await response.text().catch(() => '');
          throw new PtvV11ApiError(
            `PTV v11 request failed: ${method} ${path} -> ${response.status} ${text}`.trim(),
            response.status,
            path,
          );
        }

        await sleep(retryDelayMs(attempt, response.headers.get('Retry-After')));
      } catch (err) {
        lastError = err;
        if (err instanceof PtvV11ApiError) throw err;
        if (attempt === this.maxRetries) break;
        await sleep(retryDelayMs(attempt, null));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`PTV v11 request failed: ${method} ${path}`);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const base = 250 * 2 ** attempt;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

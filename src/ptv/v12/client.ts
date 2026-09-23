import type { PtvEnvironment } from '../adapter.js';

export const V12_BASE_URLS: Record<PtvEnvironment, string> = {
  production: 'https://api-gw.palvelutietovaranto.suomi.fi',
  test: 'https://api-gw.palvelutietovaranto.trn.suomi.fi',
};

export interface PtvV12ClientOptions {
  environment: PtvEnvironment;
  apiKey: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export class PtvV12ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'PtvV12ApiError';
  }
}

export class PtvV12Client {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(options: PtvV12ClientOptions) {
    this.baseUrl = V12_BASE_URLS[options.environment];
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async get<T>(
    path: string,
    query?: Record<string, string | number | readonly string[] | undefined>,
  ): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  private async request<T>(
    method: 'GET',
    path: string,
    query?: Record<string, string | number | readonly string[] | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            for (const item of value) url.searchParams.append(key, item);
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      }
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: { Accept: 'application/json', 'x-api-key': this.apiKey },
        });

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          const body = await response.json();
          if (process.env.PTV_V12_DEBUG_RAW === 'true') {
            console.log(
              `[PTV v12 raw] ${method} ${url.toString()}\n${JSON.stringify(body, null, 2)}`,
            );
          }
          return body as T;
        }

        if (!isRetryable(response.status) || attempt === this.maxRetries) {
          const body = await response.text().catch(() => '');
          throw new PtvV12ApiError(
            `PTV v12 request failed: ${method} ${path} -> ${response.status} ${body}`.trim(),
            response.status,
            path,
          );
        }
        await sleep(retryDelayMs(attempt, response.headers.get('Retry-After')));
      } catch (err) {
        if (err instanceof PtvV12ApiError) throw err;
        if (attempt === this.maxRetries) throw err;
        await sleep(retryDelayMs(attempt, null));
      }
    }
    throw new Error('PTV v12 request failed');
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return 250 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

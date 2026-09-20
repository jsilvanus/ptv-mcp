const ACCESS_TOKEN_KEY = 'ptv_mcp_access_token';
const REFRESH_TOKEN_KEY = 'ptv_mcp_refresh_token';

export interface Session {
  accessToken: string;
  refreshToken: string;
}

/**
 * Tokens live in localStorage — simplest option for an internal admin
 * tool's MVP, at the cost of XSS exposure (a documented, accepted
 * limitation; see EXECUTION_LOG.md). Revisit with httpOnly cookies if
 * this UI ever needs to defend against a more adversarial environment.
 */
export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setSession(session: Session): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, session.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export class ApiError extends Error {
  // Vite's `erasableSyntaxOnly` tsconfig setting disallows the usual
  // `constructor(public readonly status: number, ...)` shorthand (it
  // generates a real assignment, not just a type) — assign explicitly instead.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let inFlightRefresh: Promise<void> | null = null;

/**
 * Concurrent 401s (e.g. two components' load effects firing at once) must
 * share one refresh call, not each POST the same raw refresh token to
 * `/auth/refresh`. The backend rotates + revokes on each use and treats a
 * second use of an already-rotated token as theft, revoking every session
 * for the user (`src/auth/authService.ts`'s reuse-detection) — without
 * this dedup, an ordinary page load with an expired access token could
 * force-logout the user everywhere.
 */
function refreshAccessToken(): Promise<void> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = doRefreshAccessToken().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefreshAccessToken(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new ApiError(401, 'Not logged in');
  }
  const res = await fetch('/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    clearSession();
    throw new ApiError(res.status, 'Session expired — please log in again');
  }
  setSession((await res.json()) as Session);
}

/**
 * Fetch wrapper: attaches the bearer token, retries exactly once via
 * `/auth/refresh` on a 401 (matching the backend's short-lived access
 * token + long-lived refresh token design — see src/auth/authService.ts),
 * and throws `ApiError` for any other non-2xx response.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  allowRefresh = true,
): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401 && allowRefresh && getRefreshToken()) {
    await refreshAccessToken();
    return apiFetch<T>(path, options, false);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, (body as { message?: string }).message ?? res.statusText);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AccountLockedError, type AuthService } from '../auth/authService.js';
import type { OAuthService } from '../mcp/oauthService.js';
import type { TenantService } from '../tenants/tenantService.js';
import {
  authorizationRequestError,
  connectionSelectionPage,
  decodeAuthorizationRequest,
  escapeHtml,
  html,
} from '../mcp/oauthRoutes.js';
import type { OidcClient } from '../oidc/oidcClient.js';
import {
  OIDC_STATE_TTL_SECONDS,
  OidcSignInError,
  type OidcPurpose,
  type OidcService,
} from '../oidc/oidcService.js';
import { FixedWindowRateLimiter } from '../oidc/rateLimit.js';

export const OIDC_STATE_COOKIE = 'ptv_mcp_oidc';

export interface OidcRoutesOptions {
  oidcClient: OidcClient;
  oidcService: OidcService;
  authService: AuthService;
  oauthService: OAuthService;
  tenantService: TenantService;
  publicUrl: string;
  buttonLabel: string;
  /** Secure cookie flag. */
  secureCookies: boolean;
  /** Per-IP limit on `/oidc/login` starts per minute (default 30). */
  loginRateLimitPerMinute?: number;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Only the error's kind, never its details: those can echo IdP responses. */
function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...('code' in err && typeof err.code === 'string' ? { code: err.code } : {}),
    };
  }
  return { name: typeof err };
}

/** Where an error page links back to: the MCP sign-in page for a pending authorization, else the web UI login. */
function backLink(oauthRequest: string | null | undefined): string {
  const q = oauthRequest ? decodeAuthorizationRequest(oauthRequest) : null;
  if (q?.client_id) {
    const params = new URLSearchParams({ response_type: 'code', ...q });
    return `/oauth/authorize?${params.toString()}`;
  }
  return '/login';
}

/**
 * OpenID Connect sign-in (Relying Party). Registered only when `OIDC_ISSUER`
 * is set, so every `/oidc/*` route is a 404 otherwise.
 *
 * - `GET /oidc/config` — lets the web UI know to show the SSO button.
 * - `GET /oidc/login` (web UI) or `GET /oidc/login?oauth=<pending request>`
 *   (MCP authorize page) — starts a sign-in at the IdP.
 * - `GET /oidc/callback` — the single redirect URI for both.
 * - `POST /oidc/session` — the web UI exchanges its one-time code for the
 *   same session `POST /auth/login` returns.
 */
export async function oidcRoutes(app: FastifyInstance, options: OidcRoutesOptions): Promise<void> {
  const limiter = new FixedWindowRateLimiter(options.loginRateLimitPerMinute ?? 30, 60_000);

  const cookie = (value: string, maxAge: number) =>
    `${OIDC_STATE_COOKIE}=${value}; Path=/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (options.secureCookies ? '; Secure' : '');

  function errorPage(
    reply: FastifyReply,
    status: number,
    message: string,
    oauthRequest?: string | null,
  ) {
    return reply
      .code(status)
      .type('text/html')
      .send(
        html(
          `<h1>Sign-in failed</h1><p class="error">${escapeHtml(message)}</p><p><a href="${escapeHtml(backLink(oauthRequest))}">Back to sign-in</a></p>`,
        ),
      );
  }

  app.get('/oidc/config', async (_request, reply) =>
    reply.send({ buttonLabel: options.buttonLabel }),
  );

  app.get<{ Querystring: { oauth?: string } }>('/oidc/login', async (request, reply) => {
    if (!limiter.allow(request.ip)) {
      return reply
        .code(429)
        .type('text/html')
        .send(html('<h1>Too many sign-in attempts</h1><p>Please wait a minute and try again.</p>'));
    }

    let purpose: OidcPurpose = 'web';
    let oauthRequest: string | null = null;
    if (request.query.oauth !== undefined) {
      const q = decodeAuthorizationRequest(request.query.oauth);
      const error = q
        ? await authorizationRequestError(q, options.oauthService, options.publicUrl)
        : 'Invalid authorization request';
      if (error) return reply.badRequest(error);
      purpose = 'oauth';
      oauthRequest = request.query.oauth;
    }

    let start;
    try {
      start = await options.oidcClient.start();
    } catch (err) {
      request.log.error({ err: errorSummary(err) }, 'OIDC discovery failed');
      return errorPage(
        reply,
        502,
        'The single sign-on service is not available right now. Please try again later.',
        oauthRequest,
      );
    }
    await options.oidcService.saveLoginState(start.state, {
      codeVerifier: start.codeVerifier,
      nonce: start.nonce,
      purpose,
      oauthRequest,
    });
    return reply
      .header('set-cookie', cookie(start.state, OIDC_STATE_TTL_SECONDS))
      .header('cache-control', 'no-store')
      .redirect(start.url.toString());
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/oidc/callback',
    async (request, reply) => {
      reply.header('set-cookie', cookie('', 0)).header('cache-control', 'no-store');
      const q = request.query;
      const cookieState = readCookie(request, OIDC_STATE_COOKIE);

      if (q.error) {
        // Still consume the matching state so it cannot be used again.
        const state =
          cookieState && q.state === cookieState
            ? await options.oidcService.consumeLoginState(cookieState)
            : null;
        request.log.warn(
          { oidcError: q.error, oidcErrorDescription: q.error_description },
          'OIDC sign-in refused by the identity provider',
        );
        return errorPage(
          reply,
          400,
          'The single sign-on service did not complete the sign-in.',
          state?.oauthRequest,
        );
      }

      if (!cookieState || !q.state || q.state !== cookieState) {
        request.log.warn('OIDC callback state does not match the sign-in cookie');
        return errorPage(
          reply,
          400,
          'This sign-in link is not valid in this browser. Please start the sign-in again.',
        );
      }

      const state = await options.oidcService.consumeLoginState(cookieState);
      if (!state) {
        request.log.warn('OIDC callback with an unknown, used or expired state');
        return errorPage(
          reply,
          400,
          'This sign-in has expired or was already used. Please start the sign-in again.',
        );
      }

      let userId: string;
      try {
        // The registered redirect URI with this request's query: behind a
        // reverse proxy request.url has neither the public origin nor any
        // path prefix of the public URL.
        const callbackUrl = new URL(options.oidcClient.redirectUri);
        callbackUrl.search = new URL(request.url, 'http://localhost').search;
        const claims = await options.oidcClient.finish(callbackUrl, {
          state: cookieState,
          nonce: state.nonce,
          codeVerifier: state.codeVerifier,
        });
        userId = await options.oidcService.resolveUser(claims);
        await options.authService.assertCanSignIn(userId);
      } catch (err) {
        if (err instanceof OidcSignInError) {
          request.log.warn({ err: errorSummary(err) }, 'OIDC sign-in refused');
          return errorPage(reply, 403, err.message, state.oauthRequest);
        }
        if (err instanceof AccountLockedError) {
          request.log.warn('OIDC sign-in refused: account locked');
          return errorPage(
            reply,
            403,
            'Account temporarily locked after too many failed attempts.',
            state.oauthRequest,
          );
        }
        request.log.error({ err: errorSummary(err) }, 'OIDC sign-in failed');
        return errorPage(
          reply,
          400,
          'The sign-in could not be verified. Please try again.',
          state.oauthRequest,
        );
      }

      if (state.purpose === 'web') {
        const code = await options.oidcService.createWebHandoff(userId);
        return reply.redirect(`/login#oidc=${encodeURIComponent(code)}`);
      }

      // purpose 'oauth': continue exactly where a password sign-in on
      // /oauth/authorize continues. Like that path, this mints no web-UI
      // session: the MCP client gets its own OAuth tokens.
      const pending = state.oauthRequest ? decodeAuthorizationRequest(state.oauthRequest) : null;
      const invalid = pending
        ? await authorizationRequestError(pending, options.oauthService, options.publicUrl)
        : 'Invalid authorization request';
      if (!pending || invalid) {
        request.log.warn({ reason: invalid }, 'OIDC sign-in: pending authorization is invalid');
        return errorPage(reply, 400, 'The authorization request is no longer valid.');
      }
      return reply.type('text/html').send(await connectionSelectionPage(options, userId, pending));
    },
  );

  app.post<{ Body: { code?: unknown } }>('/oidc/session', async (request, reply) => {
    const code = request.body?.code;
    if (typeof code !== 'string' || code === '') return reply.badRequest('code is required');
    const userId = await options.oidcService.consumeWebHandoff(code);
    if (!userId) return reply.unauthorized('Invalid or expired sign-in code');
    try {
      return reply.send(await options.authService.createSession(userId));
    } catch (err) {
      if (err instanceof AccountLockedError) {
        return reply.code(423).send({ message: err.message });
      }
      throw err;
    }
  });
}

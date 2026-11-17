import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AccountLockedError,
  type AuthService,
  InvalidOrExpiredTokenError,
  PasswordRegistrationDisabledError,
} from '../auth/authService.js';
import { createAuthenticate } from '../auth/rbac.js';
import { FixedWindowRateLimiter } from '../oidc/rateLimit.js';
import { rateLimitHook } from './rateLimitHook.js';

export interface AuthRoutesOptions {
  /**
   * Builds the IdP's sign-out URL for an OIDC session's ID token. Present only
   * with OIDC configured. Null or a throw means: sign out locally only.
   */
  endSessionUrl?: (idTokenHint: string) => Promise<string | null>;
  authService: AuthService;
  jwtSecret: string;
  /** Per client IP and route; defaults 30 (login, register) and 10 (password-reset requests). */
  rateLimitPerMinute?: { login?: number; register?: number; passwordReset?: number };
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const token = z.string().min(1).max(512);
const password = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

const registerBody = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  password,
});
// Login stays lenient about the email's shape so an older odd account can still sign in.
const loginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
const refreshBody = z.object({ refreshToken: token });
const verifyEmailBody = z.object({ token });
const requestPasswordResetBody = z.object({ email: z.string().min(1).max(320) });
const resetPasswordBody = z.object({ token, newPassword: password });

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { authService } = options;
  const authenticate = createAuthenticate(options.jwtSecret);
  const limits = options.rateLimitPerMinute ?? {};
  const loginLimit = rateLimitHook(new FixedWindowRateLimiter(limits.login ?? 30, 60_000));
  const registerLimit = rateLimitHook(new FixedWindowRateLimiter(limits.register ?? 30, 60_000));
  const resetLimit = rateLimitHook(new FixedWindowRateLimiter(limits.passwordReset ?? 10, 60_000));

  /** The parsed body, or a 400 with the first problem. */
  function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      throw app.httpErrors.badRequest(
        issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request body',
      );
    }
    return result.data;
  }

  app.post('/auth/register', { preHandler: registerLimit }, async (request, reply) => {
    const { email, name, password } = parseBody(registerBody, request.body);
    try {
      const { userId } = await authService.register(email, name, password);
      return reply.code(201).send({ userId, email: email.trim().toLowerCase() });
    } catch (err) {
      if (err instanceof PasswordRegistrationDisabledError) {
        return reply.forbidden(err.message);
      }
      throw err;
    }
  });

  app.post('/auth/verify-email', async (request, reply) => {
    await authService.verifyEmail(parseBody(verifyEmailBody, request.body).token);
    return reply.code(204).send();
  });

  app.post('/auth/login', { preHandler: loginLimit }, async (request, reply) => {
    const { email, password } = parseBody(loginBody, request.body);
    try {
      const session = await authService.login(email, password);
      return reply.send(session);
    } catch (err) {
      // 423 with a bare `{ message }` body, unlike the error handler's shape.
      if (err instanceof AccountLockedError) {
        return reply.code(423).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = parseBody(refreshBody, request.body);
    try {
      const session = await authService.refresh(refreshToken);
      return reply.send(session);
    } catch (err) {
      // The error handler answers 400 for this; a failed refresh is a 401.
      if (err instanceof InvalidOrExpiredTokenError) {
        return reply.unauthorized(err.message);
      }
      throw err;
    }
  });

  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const { refreshToken } = parseBody(refreshBody, request.body);
    const { oidcIdTokenHint } = await authService.logout(request.userId!, refreshToken);
    const endSessionUrl =
      oidcIdTokenHint && options.endSessionUrl
        ? await options.endSessionUrl(oidcIdTokenHint).catch((err: unknown) => {
            request.log.warn({ err }, 'OIDC end-session URL unavailable; signed out locally');
            return null;
          })
        : null;
    if (endSessionUrl) return reply.code(200).send({ endSessionUrl });
    return reply.code(204).send();
  });

  app.post('/auth/request-password-reset', { preHandler: resetLimit }, async (request, reply) => {
    await authService.requestPasswordReset(parseBody(requestPasswordResetBody, request.body).email);
    // Always 202, regardless of whether the email is registered (docs/plan.md: don't leak enumeration).
    return reply.code(202).send();
  });

  app.post('/auth/reset-password', async (request, reply) => {
    const { token, newPassword } = parseBody(resetPasswordBody, request.body);
    await authService.resetPassword(token, newPassword);
    return reply.code(204).send();
  });
}

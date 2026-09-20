import type { FastifyInstance } from 'fastify';
import {
  AccountLockedError,
  type AuthService,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidOrExpiredTokenError,
} from '../auth/authService.js';
import { createAuthenticate } from '../auth/rbac.js';

export interface AuthRoutesOptions {
  authService: AuthService;
  jwtSecret: string;
}

interface RegisterBody {
  email: string;
  name: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface RefreshBody {
  refreshToken: string;
}

interface VerifyEmailBody {
  token: string;
}

interface RequestPasswordResetBody {
  email: string;
}

interface ResetPasswordBody {
  token: string;
  newPassword: string;
}

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { authService } = options;
  const authenticate = createAuthenticate(options.jwtSecret);

  app.post<{ Body: RegisterBody }>('/auth/register', async (request, reply) => {
    const { email, name, password } = request.body;
    if (!email || !name || !password) {
      return reply.badRequest('email, name, and password are required');
    }
    try {
      const { userId } = await authService.register(email, name, password);
      return reply.code(201).send({ userId, email });
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return reply.conflict(err.message);
      }
      throw err;
    }
  });

  app.post<{ Body: VerifyEmailBody }>('/auth/verify-email', async (request, reply) => {
    try {
      await authService.verifyEmail(request.body.token);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof InvalidOrExpiredTokenError) {
        return reply.badRequest(err.message);
      }
      throw err;
    }
  });

  app.post<{ Body: LoginBody }>('/auth/login', async (request, reply) => {
    const { email, password } = request.body;
    if (!email || !password) {
      return reply.badRequest('email and password are required');
    }
    try {
      const session = await authService.login(email, password);
      return reply.send(session);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return reply.unauthorized(err.message);
      }
      if (err instanceof AccountLockedError) {
        return reply.code(423).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: RefreshBody }>('/auth/refresh', async (request, reply) => {
    try {
      const session = await authService.refresh(request.body.refreshToken);
      return reply.send(session);
    } catch (err) {
      if (err instanceof InvalidOrExpiredTokenError) {
        return reply.unauthorized(err.message);
      }
      throw err;
    }
  });

  app.post<{ Body: RefreshBody }>(
    '/auth/logout',
    { preHandler: authenticate },
    async (request, reply) => {
      await authService.logout(request.userId!, request.body.refreshToken);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: RequestPasswordResetBody }>(
    '/auth/request-password-reset',
    async (request, reply) => {
      await authService.requestPasswordReset(request.body.email);
      // Always 202, regardless of whether the email is registered (docs/plan.md: don't leak enumeration).
      return reply.code(202).send();
    },
  );

  app.post<{ Body: ResetPasswordBody }>('/auth/reset-password', async (request, reply) => {
    try {
      await authService.resetPassword(request.body.token, request.body.newPassword);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof InvalidOrExpiredTokenError) {
        return reply.badRequest(err.message);
      }
      throw err;
    }
  });
}

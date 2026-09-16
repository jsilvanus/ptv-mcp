import type { FastifyInstance } from 'fastify';
import {
  buildAuthorizationUrl,
  generateState,
  parseCallbackFragment,
} from '../ptv/v11/auth/oauth.js';
import { introspectToken, revokeToken } from '../ptv/v11/auth/introspection.js';
import { createAuthenticate } from '../auth/rbac.js';
import type {
  PtvEnvironment,
  UserPtvConnectionService,
} from '../credentials/userPtvConnectionService.js';

export interface PtvConnectionRoutesOptions {
  connectionService: UserPtvConnectionService;
  jwtSecret: string;
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
}

interface AuthorizeUrlQuery {
  environment: PtvEnvironment;
}

interface CallbackBody {
  environment: PtvEnvironment;
  fragment: string;
}

/**
 * The user-facing side of v11's per-user consent flow (docs/ptv-v11-notes.md):
 * an authorization link, the callback that captures the implicit grant's
 * fragment and validates it via introspection before storing it, and
 * disconnect/revocation. `PTV_V11_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`
 * being unset (see config.ts) means these routes work but won't produce a
 * usable flow until a real client is registered with PTV — an external
 * prerequisite, not something this code can fix.
 */
export async function ptvConnectionRoutes(
  app: FastifyInstance,
  options: PtvConnectionRoutesOptions,
): Promise<void> {
  const { connectionService, oauth } = options;
  const authenticate = createAuthenticate(options.jwtSecret);

  app.get('/ptv-connections', { preHandler: authenticate }, async (request) => {
    return connectionService.listConnections(request.userId!);
  });

  app.get<{ Querystring: AuthorizeUrlQuery }>(
    '/ptv-connections/v11/authorize-url',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!request.query.environment) {
        return reply.badRequest('environment is required');
      }
      const state = generateState();
      const url = buildAuthorizationUrl({
        clientId: oauth.clientId,
        redirectUri: oauth.redirectUri,
        state,
      });
      return reply.send({ url, state });
    },
  );

  app.post<{ Body: CallbackBody }>(
    '/ptv-connections/v11/callback',
    { preHandler: authenticate },
    async (request, reply) => {
      const { environment, fragment } = request.body;
      if (!environment || !fragment) {
        return reply.badRequest('environment and fragment are required');
      }

      const parsed = parseCallbackFragment(fragment);
      if ('error' in parsed) {
        return reply.badRequest(`PTV authorization failed: ${parsed.error}`);
      }

      const introspection = await introspectToken(parsed.accessToken, {
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
      });
      if (!introspection.active) {
        return reply.badRequest('PTV rejected the captured access token as inactive');
      }

      const expiresAt = new Date(Date.now() + parsed.expiresInSeconds * 1000);
      await connectionService.storeConnection(
        request.userId!,
        'v11',
        environment,
        parsed.accessToken,
        expiresAt,
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { environment: PtvEnvironment } }>(
    '/ptv-connections/v11/:environment',
    { preHandler: authenticate },
    async (request, reply) => {
      const { environment } = request.params;
      try {
        const { accessToken } = await connectionService.getDecryptedConnection(
          request.userId!,
          'v11',
          environment,
        );
        await revokeToken(accessToken, {
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
        });
      } catch {
        // Already disconnected, or PTV's revocation call failed — either way, our
        // own record is the source of truth for whether we'll use this token again.
      }
      await connectionService.revokeConnection(request.userId!, 'v11', environment);
      return reply.code(204).send();
    },
  );
}

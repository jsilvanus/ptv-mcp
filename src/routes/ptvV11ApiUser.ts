import type { FastifyInstance } from 'fastify';
import type {
  TenantEnvironmentService,
  PtvEnvironment,
} from '../credentials/tenantEnvironmentService.js';
import type { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import type { Database } from '../db/client.js';
import { createAuthenticate, createRequireRole } from '../auth/rbac.js';
import {
  fetchV11ApiToken,
  parseV11ApiUserCredentials,
  V11ApiLoginError,
} from '../ptv/v11/auth/apiLogin.js';

interface ConfigBody {
  environment: PtvEnvironment;
  username: string;
  password: string;
  apiUserOrganisation?: string;
}

export interface PtvV11ApiUserRoutesOptions {
  tenantEnvironmentService: TenantEnvironmentService;
  adapterConfigService: PtvAdapterConfigService;
  db: Database;
  jwtSecret: string;
  /** Tests inject a fake PTV login endpoint. */
  fetchImpl?: typeof fetch;
}

/**
 * Tenant-admin management of the organisation's PTV v11 API user — the
 * tenant-scoped credential DVV issues for IN-API (write) access. Saving
 * it switches the tenant's v11 adapter config for that environment to
 * tenant-scoped credentials with write enabled; publishing still goes
 * through the proposal flow and needs the Publisher role.
 */
export async function ptvV11ApiUserRoutes(
  app: FastifyInstance,
  options: PtvV11ApiUserRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireTenantAdmin = createRequireRole(options.db, 'tenant_admin');
  const isEnvironment = (value: unknown): value is PtvEnvironment =>
    value === 'test' || value === 'production';

  app.get(
    '/tenants/:tenantId/ptv/v11/api-user',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const configs = await options.adapterConfigService.list(tenantId);
      const result = [];
      for (const config of configs) {
        if (config.apiVersion !== 'v11' || config.credentialScope !== 'tenant') continue;
        const credentials = parseV11ApiUserCredentials(
          await options.tenantEnvironmentService
            .getDecryptedCredentials(tenantId, config.environment, 'v11')
            .catch(() => undefined),
        );
        result.push({
          environment: config.environment,
          // The username is shown so admins can tell which API user is in
          // use; the password never leaves the server.
          username: credentials?.username ?? null,
          apiUserOrganisation: credentials?.apiUserOrganisation ?? null,
          supportsRead: config.supportsRead,
          supportsWrite: config.supportsWrite,
        });
      }
      return result;
    },
  );

  app.put<{ Params: { tenantId: string }; Body: ConfigBody }>(
    '/tenants/:tenantId/ptv/v11/api-user',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId } = request.params;
      const { environment, username, password, apiUserOrganisation } = request.body ?? {};
      if (!isEnvironment(environment)) {
        return reply.badRequest('environment must be test or production');
      }
      if (!username?.trim() || !password) {
        return reply.badRequest('username and password are required');
      }

      await options.tenantEnvironmentService.storeCredentials(tenantId, environment, 'v11', {
        username: username.trim(),
        password,
        ...(apiUserOrganisation?.trim() ? { apiUserOrganisation: apiUserOrganisation.trim() } : {}),
      });
      await options.adapterConfigService.upsert(tenantId, environment, 'v11', {
        authMode: 'api_login',
        credentialScope: 'tenant',
        supportsRead: true,
        supportsWrite: true,
        supportsDraftRead: false,
      });

      return reply.code(204).send();
    },
  );

  app.post<{ Params: { tenantId: string; environment: string } }>(
    '/tenants/:tenantId/ptv/v11/api-user/:environment/test',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId, environment } = request.params;
      if (!isEnvironment(environment)) {
        return reply.badRequest('environment must be test or production');
      }
      const credentials = parseV11ApiUserCredentials(
        await options.tenantEnvironmentService
          .getDecryptedCredentials(tenantId, environment, 'v11')
          .catch(() => undefined),
      );
      if (!credentials) return reply.badRequest('No v11 API user configured');

      try {
        const { expiresAt } = await fetchV11ApiToken(
          environment,
          credentials,
          options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
        );
        return {
          ok: true,
          environment,
          apiVersion: 'v11',
          tokenExpiresAt: new Date(expiresAt).toISOString(),
        };
      } catch (err) {
        const message = err instanceof V11ApiLoginError ? err.message : 'PTV v11 API login failed';
        return reply.badGateway(message);
      }
    },
  );
}

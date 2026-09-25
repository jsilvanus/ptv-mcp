import type { FastifyInstance } from 'fastify';
import type {
  TenantEnvironmentService,
  PtvEnvironment,
} from '../credentials/tenantEnvironmentService.js';
import type { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import type { Database } from '../db/client.js';
import type { AuditService } from '../audit/auditService.js';
import { createAuthenticate, createRequireRole } from '../auth/rbac.js';
import {
  fetchV11ApiToken,
  parseV11ApiUserCredentials,
  V11ApiLoginError,
} from '../ptv/v11/auth/apiLogin.js';
import { isPtvEnvironment } from './context.js';

interface ConfigBody {
  environment: PtvEnvironment;
  username: string;
  password: string;
  apiUserOrganisation?: string;
  /** PTV organisation this API user writes to (informational; a test token is bound to one). */
  organisationId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PtvV11ApiUserRoutesOptions {
  tenantEnvironmentService: TenantEnvironmentService;
  adapterConfigService: PtvAdapterConfigService;
  auditService: AuditService;
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
          organisationId: credentials?.organisationId ?? null,
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
      const { environment, username, password, apiUserOrganisation, organisationId } =
        request.body ?? {};
      if (!isPtvEnvironment(environment)) {
        return reply.badRequest('environment must be test or production');
      }
      if (!username?.trim() || !password) {
        return reply.badRequest('username and password are required');
      }
      if (organisationId && !UUID.test(organisationId)) {
        return reply.badRequest('organisationId must be a PTV organisation id (UUID)');
      }

      const previous = parseV11ApiUserCredentials(
        await options.tenantEnvironmentService
          .getDecryptedCredentials(tenantId, environment, 'v11')
          .catch(() => undefined),
      );
      await options.tenantEnvironmentService.storeCredentials(tenantId, environment, 'v11', {
        username: username.trim(),
        password,
        ...(apiUserOrganisation?.trim() ? { apiUserOrganisation: apiUserOrganisation.trim() } : {}),
        ...(organisationId ? { organisationId: organisationId.toLowerCase() } : {}),
      });
      await options.adapterConfigService.upsert(tenantId, environment, 'v11', {
        authMode: 'api_login',
        credentialScope: 'tenant',
        supportsRead: true,
        supportsWrite: true,
        supportsDraftRead: false,
      });
      // Who changed which API user; never the password.
      await options.auditService.record({
        tenantId,
        userId: request.userId ?? null,
        action: 'SetPtvV11ApiUser',
        resourceType: 'TenantEnvironment',
        resourceId: `${environment}/v11`,
        apiVersion: 'v11',
        environment,
        beforeState: previous ? { username: previous.username } : null,
        afterState: {
          username: username.trim(),
          apiUserOrganisation: apiUserOrganisation?.trim() || null,
          organisationId: organisationId?.toLowerCase() ?? null,
        },
        result: previous ? 'Replaced' : 'Created',
      });

      return reply.code(204).send();
    },
  );

  app.post<{ Params: { tenantId: string; environment: string } }>(
    '/tenants/:tenantId/ptv/v11/api-user/:environment/test',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId, environment } = request.params;
      if (!isPtvEnvironment(environment)) {
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

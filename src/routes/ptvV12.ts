import type { FastifyInstance } from 'fastify';
import type {
  TenantEnvironmentService,
  PtvEnvironment,
} from '../credentials/tenantEnvironmentService.js';
import type { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import type { Database } from '../db/client.js';
import { createAuthenticate, createRequireRole } from '../auth/rbac.js';
import { PtvV12Client } from '../ptv/v12/client.js';

interface ConfigBody {
  environment: PtvEnvironment;
  apiKey: string;
}

export interface PtvV12RoutesOptions {
  tenantEnvironmentService: TenantEnvironmentService;
  adapterConfigService: PtvAdapterConfigService;
  db: Database;
  jwtSecret: string;
}

export async function ptvV12Routes(
  app: FastifyInstance,
  options: PtvV12RoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireTenantAdmin = createRequireRole(options.db, 'tenant_admin');

  app.get(
    '/tenants/:tenantId/ptv/v12',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const configs = await options.adapterConfigService.list(tenantId);
      return configs
        .filter((config) => config.apiVersion === 'v12')
        .map((config) => ({
          environment: config.environment,
          apiVersion: config.apiVersion,
          authMode: config.authMode,
          credentialScope: config.credentialScope,
          supportsRead: config.supportsRead,
          supportsWrite: config.supportsWrite,
        }));
    },
  );

  app.put<{ Params: { tenantId: string }; Body: ConfigBody }>(
    '/tenants/:tenantId/ptv/v12',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId } = request.params;
      const { environment, apiKey } = request.body;
      if (!environment || !['test', 'production'].includes(environment)) {
        return reply.badRequest('environment must be test or production');
      }
      if (!apiKey?.trim()) {
        return reply.badRequest('apiKey is required');
      }

      await options.tenantEnvironmentService.storeCredentials(tenantId, environment, 'v12', {
        apiKey: apiKey.trim(),
      });
      await options.adapterConfigService.upsert(tenantId, environment, 'v12', {
        authMode: 'api_key',
        credentialScope: 'tenant',
        supportsRead: true,
        supportsWrite: false,
        supportsDraftRead: false,
      });

      return reply.code(204).send();
    },
  );

  app.post<{ Params: { tenantId: string; environment: PtvEnvironment } }>(
    '/tenants/:tenantId/ptv/v12/:environment/test',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId, environment } = request.params;
      if (!['test', 'production'].includes(environment)) {
        return reply.badRequest('environment must be test or production');
      }

      const credentials = await options.tenantEnvironmentService.getDecryptedCredentials(
        tenantId,
        environment,
        'v12',
      );
      const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey : '';
      if (!apiKey) return reply.badRequest('No v12 API key configured');

      const client = new PtvV12Client({ environment, apiKey });
      try {
        await client.get('/api/v12/municipality-codes', { page: 1, pageSize: 1 });
        return { ok: true, environment, apiVersion: 'v12' };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'PTV v12 connection test failed';
        return reply.badGateway(message);
      }
    },
  );
}

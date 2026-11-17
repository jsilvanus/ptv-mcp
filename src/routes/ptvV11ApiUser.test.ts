import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/auditService.js';
import type { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import type { TenantEnvironmentService } from '../credentials/tenantEnvironmentService.js';
import { V11ApiLoginError } from '../ptv/v11/auth/apiLogin.js';
import { routeErrorHandler } from './errorHandler.js';
import { ptvV11ApiUserRoutes, type PtvV11ApiUserRoutesOptions } from './ptvV11ApiUser.js';

// Authentication and the tenant-admin check are not under test here; the
// fake caller is always a tenant admin.
vi.mock('../auth/rbac.js', () => ({
  createAuthenticate: () => async (request: { userId?: string }) => {
    request.userId = 'user-1';
  },
  createRequireRole: () => async () => {},
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'correct-horse-9';

interface Fakes {
  tenantEnvironmentService: {
    getDecryptedCredentials: ReturnType<typeof vi.fn>;
    storeCredentials: ReturnType<typeof vi.fn>;
  };
  adapterConfigService: { list: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  auditService: { record: ReturnType<typeof vi.fn> };
  login: ReturnType<typeof vi.fn>;
}

function makeFakes(login: Fakes['login']): Fakes {
  return {
    tenantEnvironmentService: {
      getDecryptedCredentials: vi.fn(async () => undefined),
      storeCredentials: vi.fn(async () => undefined),
    },
    adapterConfigService: {
      list: vi.fn(async () => []),
      upsert: vi.fn(async () => undefined),
    },
    auditService: { record: vi.fn(async () => undefined) },
    login,
  };
}

async function buildApp(fakes: Fakes): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(sensible);
  app.setErrorHandler(routeErrorHandler);
  await app.register(ptvV11ApiUserRoutes, {
    tenantEnvironmentService: fakes.tenantEnvironmentService as unknown as TenantEnvironmentService,
    adapterConfigService: fakes.adapterConfigService as unknown as PtvAdapterConfigService,
    auditService: fakes.auditService as unknown as AuditService,
    db: {} as never,
    jwtSecret: 'test-secret',
    login: fakes.login as unknown as NonNullable<PtvV11ApiUserRoutesOptions['login']>,
  });
  return app;
}

const payload = {
  environment: 'test',
  username: ' API1@testi.fi ',
  password: PASSWORD,
  organisationId: 'AE788356-6950-48FC-B3FF-63243F74FE53',
};

describe('PUT /tenants/:tenantId/ptv/v11/api-user', () => {
  let fakes: Fakes;
  let app: FastifyInstance;

  beforeEach(async () => {
    fakes = makeFakes(vi.fn(async () => ({ token: 'tok', expiresAt: Date.now() + 3600_000 })));
    app = await buildApp(fakes);
  });

  it('test-logs in with the supplied credentials, then stores them and enables writes', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/tenants/${TENANT}/ptv/v11/api-user`,
      payload,
    });

    expect(res.statusCode).toBe(204);
    expect(fakes.login).toHaveBeenCalledTimes(1);
    expect(fakes.login).toHaveBeenCalledWith('test', {
      username: 'API1@testi.fi',
      password: PASSWORD,
      organisationId: 'ae788356-6950-48fc-b3ff-63243f74fe53',
    });
    expect(fakes.tenantEnvironmentService.storeCredentials).toHaveBeenCalledWith(
      TENANT,
      'test',
      'v11',
      {
        username: 'API1@testi.fi',
        password: PASSWORD,
        organisationId: 'ae788356-6950-48fc-b3ff-63243f74fe53',
      },
    );
    expect(fakes.adapterConfigService.upsert).toHaveBeenCalledWith(TENANT, 'test', 'v11', {
      authMode: 'api_login',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: true,
      supportsDraftRead: true,
    });
    expect(fakes.auditService.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fakes.auditService.record.mock.calls)).not.toContain(PASSWORD);
  });

  it('logs in before anything is stored', async () => {
    await app.inject({ method: 'PUT', url: `/tenants/${TENANT}/ptv/v11/api-user`, payload });

    const loginOrder = fakes.login.mock.invocationCallOrder[0]!;
    expect(loginOrder).toBeLessThan(
      fakes.tenantEnvironmentService.storeCredentials.mock.invocationCallOrder[0]!,
    );
    expect(loginOrder).toBeLessThan(fakes.adapterConfigService.upsert.mock.invocationCallOrder[0]!);
  });

  it('answers 400 on a failed login, without the password, and stores nothing', async () => {
    fakes = makeFakes(
      vi.fn(async () => {
        throw new V11ApiLoginError(
          `PTV test API login was rejected (/api/auth/api-login HTTP 401: wrong for ${PASSWORD})`,
          401,
        );
      }),
    );
    app = await buildApp(fakes);

    const res = await app.inject({
      method: 'PUT',
      url: `/tenants/${TENANT}/ptv/v11/api-user`,
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('PTV test API login was rejected');
    expect(res.body).toContain('Nothing was saved');
    expect(res.body).not.toContain(PASSWORD);
    expect(fakes.tenantEnvironmentService.storeCredentials).not.toHaveBeenCalled();
    expect(fakes.adapterConfigService.upsert).not.toHaveBeenCalled();
    expect(fakes.auditService.record).not.toHaveBeenCalled();
  });

  it('answers 400 when the login cannot reach PTV at all, and stores nothing', async () => {
    fakes = makeFakes(vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    app = await buildApp(fakes);

    const res = await app.inject({
      method: 'PUT',
      url: `/tenants/${TENANT}/ptv/v11/api-user`,
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('fetch failed');
    expect(fakes.tenantEnvironmentService.storeCredentials).not.toHaveBeenCalled();
  });

  it('keeps validation ahead of the login', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/tenants/${TENANT}/ptv/v11/api-user`,
      payload: { environment: 'test', username: 'u' },
    });

    expect(res.statusCode).toBe(400);
    expect(fakes.login).not.toHaveBeenCalled();
  });
});

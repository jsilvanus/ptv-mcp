import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries } from '../db/schema/index.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';

describe('ptv v11 API user routes', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const fixtures = new IntegrationFixtures(db, config);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fixtures.cleanup();
  });

  async function adminWithTenant(): Promise<{ token: string; tenantId: string }> {
    const token = await fixtures.webToken(await fixtures.user('Admin'));
    const res = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'API User Tenant', slug: `api-user-${randomUUID()}` },
    });
    const { tenantId } = res.json() as { tenantId: string };
    fixtures.trackTenant(tenantId);
    return { token, tenantId };
  }

  async function credentialAuditEntries(tenantId: string) {
    const rows = await withContext(db, { tenantId }, async (tx) =>
      tx.select().from(auditEntries).where(eq(auditEntries.tenantId, tenantId)),
    );
    return rows.filter((row) => row.resourceType === 'TenantEnvironment');
  }

  it('audits credential changes (v11 API user and v12 API key) without the secrets', async () => {
    const { token, tenantId } = await adminWithTenant();
    const headers = { authorization: `Bearer ${token}` };
    for (const password of ['first-pw', 'second-pw']) {
      const put = await app.inject({
        method: 'PUT',
        url: `/tenants/${tenantId}/ptv/v11/api-user`,
        headers,
        payload: { environment: 'test', username: 'API15', password },
      });
      expect(put.statusCode).toBe(204);
    }
    const v12 = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/ptv/v12`,
      headers,
      payload: { environment: 'test', apiKey: 'secret-api-key' },
    });
    expect(v12.statusCode).toBe(204);

    const audited = await credentialAuditEntries(tenantId);
    expect(audited.map((row) => [row.action, row.result, row.beforeState]).sort()).toEqual([
      ['SetPtvV11ApiUser', 'Created', null],
      ['SetPtvV11ApiUser', 'Replaced', { username: 'API15' }],
      ['SetPtvV12ApiKey', 'Created', null],
    ]);
    const serialized = JSON.stringify(audited);
    for (const secret of ['first-pw', 'second-pw', 'secret-api-key']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('stores the API user, enables tenant-scoped v11 writes, and never returns the password', async () => {
    const { token, tenantId } = await adminWithTenant();
    const headers = { authorization: `Bearer ${token}` };

    const put = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/ptv/v11/api-user`,
      headers,
      payload: {
        environment: 'test',
        username: ' API1@testi.fi ',
        password: 'pw-123',
        organisationId: 'AE788356-6950-48FC-B3FF-63243F74FE53',
      },
    });
    expect(put.statusCode).toBe(204);

    const audited = await credentialAuditEntries(tenantId);
    expect(audited).toEqual([
      expect.objectContaining({
        action: 'SetPtvV11ApiUser',
        resourceId: 'test/v11',
        result: 'Created',
        afterState: {
          username: 'API1@testi.fi',
          apiUserOrganisation: null,
          organisationId: 'ae788356-6950-48fc-b3ff-63243f74fe53',
        },
      }),
    ]);
    expect(JSON.stringify(audited)).not.toContain('pw-123');

    const config = await new PtvAdapterConfigService(db).get(tenantId, 'test', 'v11');
    expect(config).toMatchObject({
      authMode: 'api_login',
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: true,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/ptv/v11/api-user`,
      headers,
    });
    expect(list.json()).toEqual([
      {
        environment: 'test',
        username: 'API1@testi.fi',
        apiUserOrganisation: null,
        organisationId: 'ae788356-6950-48fc-b3ff-63243f74fe53',
        supportsRead: true,
        supportsWrite: true,
      },
    ]);
    expect(list.body).not.toContain('pw-123');

    const exp = Math.floor(Date.now() / 1000) + 3600;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ptvToken: `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`,
        }),
        { status: 200 },
      ),
    );
    const test = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/ptv/v11/api-user/test/test`,
      headers,
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, environment: 'test', apiVersion: 'v11' });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe('https://palvelutietovaranto.trn.suomi.fi/connect/token');
    expect(String(init?.body)).toBe('username=API1%40testi.fi&password=pw-123');
  });

  it('reports a rejected login as 502', async () => {
    const { token, tenantId } = await adminWithTenant();
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/ptv/v11/api-user`,
      headers,
      payload: { environment: 'test', username: 'u', password: 'wrong' },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 400 }));
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/ptv/v11/api-user/test/test`,
      headers,
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('wrong');
  });

  it('validates input', async () => {
    const { token, tenantId } = await adminWithTenant();
    const res = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/ptv/v11/api-user`,
      headers: { authorization: `Bearer ${token}` },
      payload: { environment: 'test', username: 'u' },
    });
    expect(res.statusCode).toBe(400);

    const badOrganisation = await app.inject({
      method: 'PUT',
      url: `/tenants/${tenantId}/ptv/v11/api-user`,
      headers: { authorization: `Bearer ${token}` },
      payload: { environment: 'test', username: 'u', password: 'p', organisationId: 'not-a-uuid' },
    });
    expect(badOrganisation.statusCode).toBe(400);
  });
});

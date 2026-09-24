import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, tenants, users } from '../db/schema/index.js';
import { signAccessToken } from '../auth/jwt.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';

describe('ptv v11 API user routes', () => {
  const config = loadConfig();
  let app: FastifyInstance;
  let db: Database;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    db = createDatabase(config.databaseUrl);
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
    for (const tenantId of createdTenantIds) {
      await withContext(db, { tenantId }, async (tx) => {
        await tx.delete(auditEntries).where(eq(auditEntries.tenantId, tenantId));
        await tx.delete(memberships).where(eq(memberships.tenantId, tenantId));
      });
    }
    if (createdTenantIds.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    createdTenantIds.length = 0;
    createdUserIds.length = 0;
  });

  async function adminWithTenant(): Promise<{ token: string; tenantId: string }> {
    const id = randomUUID();
    await db
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: 'Admin', passwordHash: 'x' });
    createdUserIds.push(id);
    const token = await signAccessToken({ sub: id }, config.jwtSecret);
    const res = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'API User Tenant', slug: `api-user-${randomUUID()}` },
    });
    const { tenantId } = res.json() as { tenantId: string };
    createdTenantIds.push(tenantId);
    return { token, tenantId };
  }

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
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'API1@testi.fi',
      password: 'pw-123',
    });
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

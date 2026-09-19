import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { auditEntries, memberships, ptvAdapterConfigs, tenants, users } from '../db/schema/index.js';
import { signAccessToken } from '../auth/jwt.js';

describe('ptv connection routes', () => {
  const config = loadConfig();
  let app: FastifyInstance;
  let db: Database;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    db = createDatabase(config.databaseUrl);
    app = await buildApp({
      config: {
        ...config,
        logLevel: 'silent',
        ptvV11OAuthClientId: 'test-client',
        ptvV11OAuthClientSecret: 'test-secret',
        ptvV11OAuthRedirectUri: 'https://app.example.test/callback',
      },
      db,
    });
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
    createdTenantIds.length = 0;
    if (createdUserIds.length > 0) {
      await db.delete(users).where(eq(users.id, createdUserIds[createdUserIds.length - 1]!));
    }
  });

  async function createUserWithToken(): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    await db
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: 'Test', passwordHash: 'x' });
    createdUserIds.push(id);
    const token = await signAccessToken({ sub: id }, config.jwtSecret);
    return { id, token };
  }

  it('returns an authorization url containing the configured client id and redirect uri', async () => {
    const user = await createUserWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/ptv-connections/v11/authorize-url?environment=production',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; state: string };
    expect(body.url).toContain('client_id=test-client');
    expect(body.url).toContain(encodeURIComponent('https://app.example.test/callback'));
    expect(body.state).toBeTruthy();
  });

  it('rejects the authorize-url request without authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ptv-connections/v11/authorize-url?environment=production',
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores a connection and enables v11 reads in both environments', async () => {
    const user = await createUserWithToken();
    const createTenantRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'Connection Config Tenant', slug: `conn-config-${randomUUID()}` },
    });
    const { tenantId } = createTenantRes.json() as { tenantId: string };
    createdTenantIds.push(tenantId);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true, sub: 'ptv-user' }), { status: 200 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/ptv-connections/v11/callback',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        environment: 'production',
        fragment: 'access_token=real-token&token_type=Bearer&expires_in=3600',
      },
    });
    expect(res.statusCode).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: '/ptv-connections',
      headers: { authorization: `Bearer ${user.token}` },
    });
    const connections = listRes.json() as Array<{ apiVersion: string; environment: string }>;
    expect(connections).toContainEqual(
      expect.objectContaining({ apiVersion: 'v11', environment: 'production' }),
    );

    const configs = await withContext(db, { tenantId }, async (tx) =>
      tx.query.ptvAdapterConfigs.findMany({ where: eq(ptvAdapterConfigs.tenantId, tenantId) }),
    );
    expect(configs).toHaveLength(2);
    expect(configs).toEqual(expect.arrayContaining([
      expect.objectContaining({ apiVersion: 'v11', environment: 'test', supportsRead: true }),
      expect.objectContaining({ apiVersion: 'v11', environment: 'production', supportsRead: true }),
    ]));
  });

  it('records a ConnectPtvAccount audit entry in every tenant the user belongs to', async () => {
    const user = await createUserWithToken();
    const createTenantRes = await app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'Connection Test Tenant', slug: `conn-${randomUUID()}` },
    });
    const { tenantId } = createTenantRes.json() as { tenantId: string };
    createdTenantIds.push(tenantId);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true, sub: 'ptv-user' }), { status: 200 }),
    );
    await app.inject({
      method: 'POST',
      url: '/ptv-connections/v11/callback',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        environment: 'production',
        fragment: 'access_token=real-token&token_type=Bearer&expires_in=3600',
      },
    });

    const auditRes = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/audit-entries?resourceType=PtvConnection`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const entries = auditRes.json() as Array<{ action: string; environment: string }>;
    expect(entries).toContainEqual(
      expect.objectContaining({ action: 'ConnectPtvAccount', environment: 'production' }),
    );
  });

  it('rejects a callback whose token introspects as inactive', async () => {
    const user = await createUserWithToken();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ active: false }), { status: 200 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/ptv-connections/v11/callback',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { environment: 'production', fragment: 'access_token=bad-token&expires_in=3600' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a callback carrying an OAuth error fragment', async () => {
    const user = await createUserWithToken();
    const res = await app.inject({
      method: 'POST',
      url: '/ptv-connections/v11/callback',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { environment: 'production', fragment: 'error=access_denied' },
    });
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disconnects a connection even if PTV revocation fails', async () => {
    const user = await createUserWithToken();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 200 }),
    );
    await app.inject({
      method: 'POST',
      url: '/ptv-connections/v11/callback',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        environment: 'production',
        fragment: 'access_token=real-token&expires_in=3600',
      },
    });

    vi.mocked(fetch).mockRejectedValueOnce(new Error('network error'));
    const disconnectRes = await app.inject({
      method: 'DELETE',
      url: '/ptv-connections/v11/production',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(disconnectRes.statusCode).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: '/ptv-connections',
      headers: { authorization: `Bearer ${user.token}` },
    });
    const connections = listRes.json() as Array<{ revokedAt: string | null }>;
    expect(connections[0]?.revokedAt).not.toBeNull();
  });
});

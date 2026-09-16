import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships, tenants, users } from '../db/schema/index.js';
import { signAccessToken } from './jwt.js';
import { createAuthenticate, createRequireRole } from './rbac.js';

describe('RBAC middleware', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  let app: FastifyInstance;

  const tenantId = randomUUID();
  const readerId = randomUUID();
  const publisherId = randomUUID();
  const outsiderId = randomUUID();

  beforeAll(async () => {
    await db.insert(tenants).values({ id: tenantId, name: 'RBAC Test', slug: `rbac-${tenantId}` });
    await db.insert(users).values([
      { id: readerId, email: `${readerId}@example.test`, name: 'Reader', passwordHash: 'x' },
      {
        id: publisherId,
        email: `${publisherId}@example.test`,
        name: 'Publisher',
        passwordHash: 'x',
      },
      { id: outsiderId, email: `${outsiderId}@example.test`, name: 'Outsider', passwordHash: 'x' },
    ]);
    await withContext(db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values([
        { userId: readerId, tenantId, role: 'reader' },
        { userId: publisherId, tenantId, role: 'publisher' },
      ]);
    });

    app = Fastify({ logger: false });
    await app.register(sensible);
    const authenticate = createAuthenticate(config.jwtSecret);
    const requirePublisher = createRequireRole(db, 'publisher');
    app.get(
      '/tenants/:tenantId/publisher-only',
      { preHandler: [authenticate, requirePublisher] },
      async (request) => ({ role: request.role }),
    );
  });

  afterAll(async () => {
    await app.close();
    await withContext(db, { tenantId }, async (tx) => {
      await tx.delete(memberships).where(eq(memberships.tenantId, tenantId));
    });
    await db.delete(users).where(inArray(users.id, [readerId, publisherId, outsiderId]));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  async function tokenFor(userId: string): Promise<string> {
    return signAccessToken({ sub: userId }, config.jwtSecret);
  }

  it('rejects a request with no bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: `/tenants/${tenantId}/publisher-only` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a reader below the required publisher role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/publisher-only`,
      headers: { authorization: `Bearer ${await tokenFor(readerId)}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a user with no membership in the tenant at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/publisher-only`,
      headers: { authorization: `Bearer ${await tokenFor(outsiderId)}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a publisher through and resolves their role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/publisher-only`,
      headers: { authorization: `Bearer ${await tokenFor(publisherId)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ role: 'publisher' });
  });
});

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig, type OidcConfig, type OidcGroupSyncConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { auditEntries, memberships } from '../db/schema/index.js';
import { OIDC_STATE_COOKIE } from '../routes/oidc.js';
import { FakeOidcProvider } from '../testing/fakeOidcProvider.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';

/**
 * OIDC_GROUP_SYNC against the fake IdP: groups in the sign-in's ID token
 * become tenant memberships (src/oidc/groupGrants.ts, OidcService.syncGroupMemberships).
 */

const CLIENT_ID = 'ptv-mcp-group-sync-test';
const CLIENT_SECRET = 'group-sync-test-secret';

describe('OIDC group sync at sign-in', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const fixtures = new IntegrationFixtures(db, config);
  const idp = new FakeOidcProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const apps: FastifyInstance[] = [];

  function oidcConfig(
    groupSync: OidcGroupSyncConfig | null = { claim: 'groups', prefix: 'parish/' },
  ): OidcConfig {
    return {
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: 'openid email profile',
      buttonLabel: 'Sign in with single sign-on',
      createUsers: false,
      trustEmail: false,
      ...(groupSync ? { groupSync } : {}),
    };
  }

  /** Sets the groups the IdP sends at the next sign-in; `undefined` leaves the claim out. */
  function sendGroups(groups: string[] | undefined) {
    const next = { ...idp.user };
    delete next.groups;
    if (groups !== undefined) next.groups = groups;
    idp.user = next;
  }

  async function app(oidc: OidcConfig): Promise<FastifyInstance> {
    const base = { ...config };
    delete base.oidc;
    const instance = await buildApp({
      config: { ...base, logLevel: 'silent', oidc },
      db,
    });
    apps.push(instance);
    return instance;
  }

  /** A web sign-in through the fake IdP; resolves with the callback response. */
  async function signIn(instance: FastifyInstance) {
    const start = await instance.inject({ method: 'GET', url: '/oidc/login' });
    expect(start.statusCode).toBe(302);
    const setCookie = String(start.headers['set-cookie']);
    const match = new RegExp(`${OIDC_STATE_COOKIE}=([^;]*)`).exec(setCookie);
    const cookie = match?.[1] ?? '';
    const atIdp = await fetch(String(start.headers.location), { redirect: 'manual' });
    const callbackUrl = new URL(atIdp.headers.get('location') ?? '');
    return instance.inject({
      method: 'GET',
      url: callbackUrl.pathname + callbackUrl.search,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${cookie}` },
    });
  }

  /** A local user whose verified IdP email links to them, with the groups the IdP will send. */
  async function userWithGroups(groups: string[] | undefined) {
    const userId = await fixtures.user('Group Sync User');
    const email = `${userId}@example.test`;
    idp.user = {
      sub: `sub-${randomUUID()}`,
      email,
      email_verified: true,
      name: 'Group Sync User',
      ...(groups === undefined ? {} : { groups }),
    };
    return userId;
  }

  async function tenantSlug(prefix: string) {
    const tenantId = await fixtures.tenant({ slugPrefix: prefix, name: `Tenant ${prefix}` });
    return { tenantId, slug: `${prefix}-${tenantId}` };
  }

  async function rowsFor(userId: string) {
    return db
      .select({
        tenantId: memberships.tenantId,
        role: memberships.role,
        source: memberships.source,
      })
      .from(memberships)
      .where(eq(memberships.userId, userId));
  }

  beforeAll(async () => {
    await idp.start();
  });

  afterAll(async () => {
    for (const instance of apps) await instance.close();
    await idp.stop();
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  it('grants the roles named by groups and records each change in the audit log', async () => {
    const instance = await app(oidcConfig());
    const a = await tenantSlug('grp-a');
    const b = await tenantSlug('grp-b');
    const userId = await userWithGroups([`parish/${a.slug}/ptv-publisher`, `parish/${b.slug}`]);

    const response = await signIn(instance);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^\/login#oidc=/);
    const rows = await rowsFor(userId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenantId: a.tenantId, role: 'publisher', source: 'oidc' },
        { tenantId: b.tenantId, role: 'viewer', source: 'oidc' },
      ]),
    );
    expect(rows).toHaveLength(2);

    const audit = await db
      .select({ action: auditEntries.action })
      .from(auditEntries)
      .where(and(eq(auditEntries.tenantId, a.tenantId), eq(auditEntries.userId, userId)));
    expect(audit.map((row) => row.action)).toEqual(['AddGroupMembership']);
  });

  it('updates a group-granted role, and removes the membership of a group that is gone', async () => {
    const instance = await app(oidcConfig());
    const a = await tenantSlug('grp-c');
    const b = await tenantSlug('grp-d');
    const userId = await userWithGroups([`parish/${a.slug}/ptv-publisher`, `parish/${b.slug}/ptv-approver`]);
    await signIn(instance);

    sendGroups([`parish/${a.slug}/ptv-contributor`]);
    await signIn(instance);

    expect(await rowsFor(userId)).toEqual([
      { tenantId: a.tenantId, role: 'contributor', source: 'oidc' },
    ]);
  });

  it('removes every group-granted membership when the groups claim is absent', async () => {
    const instance = await app(oidcConfig());
    const a = await tenantSlug('grp-e');
    const userId = await userWithGroups([`parish/${a.slug}/ptv-viewer`]);
    await signIn(instance);
    expect(await rowsFor(userId)).toHaveLength(1);

    sendGroups(undefined);
    await signIn(instance);

    expect(await rowsFor(userId)).toEqual([]);
  });

  it('never lets a manual membership be changed or removed by a group', async () => {
    const instance = await app(oidcConfig());
    const a = await tenantSlug('grp-f');
    const b = await tenantSlug('grp-g');
    const userId = await userWithGroups([`parish/${a.slug}/ptv-publisher`]);
    await db.insert(memberships).values([
      { userId, tenantId: a.tenantId, role: 'contributor', source: 'manual' },
      { userId, tenantId: b.tenantId, role: 'tenant_admin', source: 'manual' },
    ]);

    await signIn(instance);

    const rows = await rowsFor(userId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenantId: a.tenantId, role: 'contributor', source: 'manual' },
        { tenantId: b.tenantId, role: 'tenant_admin', source: 'manual' },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('grants Tenant Admin from an admin group, and skips other apps and unknown tenants', async () => {
    const instance = await app(oidcConfig());
    const a = await tenantSlug('grp-h');
    const userId = await userWithGroups([
      `parish/${a.slug}/ptv-admin`,
      `parish/${a.slug}/tavaranpaikka-keeper`,
      'parish/no-such-tenant/ptv-publisher',
      'unrelated/group',
    ]);

    const response = await signIn(instance);

    expect(response.statusCode).toBe(302);
    expect(await rowsFor(userId)).toEqual([
      { tenantId: a.tenantId, role: 'tenant_admin', source: 'oidc' },
    ]);
  });

  it('grants nothing when OIDC_GROUP_SYNC is off', async () => {
    const instance = await app(oidcConfig(null));
    const a = await tenantSlug('grp-i');
    const userId = await userWithGroups([`parish/${a.slug}/ptv-publisher`]);

    const response = await signIn(instance);

    expect(response.statusCode).toBe(302);
    expect(await rowsFor(userId)).toEqual([]);
  });

  it('keeps the migration default: existing memberships are manual', async () => {
    const a = await tenantSlug('grp-j');
    const userId = await fixtures.user('Manual User');
    await db.insert(memberships).values({ userId, tenantId: a.tenantId, role: 'viewer' });
    const [row] = await db
      .select({ source: memberships.source })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    expect(row?.source).toBe('manual');
    const [check] = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'memberships_source_check'`,
    );
    expect(check?.count).toBe(1);
  });
});

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import {
  auditEntries,
  memberships,
  proposals,
  reviewCampaigns,
  tenants,
  users,
} from '../db/schema/index.js';
import type { AuthService } from '../auth/authService.js';
import { signAccessToken } from '../auth/jwt.js';
import type { MembershipRole } from '../auth/rbac.js';
import { PtvAdapterConfigService } from '../credentials/ptvAdapterConfigService.js';
import { OAuthService } from '../mcp/oauthService.js';

/**
 * Shared set-up for DB-backed (`*.integration.test.ts`) tests. All of them
 * share one database, so every tenant and user here gets a fresh UUID and
 * is tracked for `cleanup()`, which a suite calls from its own
 * `afterEach`/`afterAll`.
 */
export class IntegrationFixtures {
  readonly adapterConfigs: PtvAdapterConfigService;
  /**
   * Built exactly like `src/app.ts`'s (same jwtSecret, and issuer ===
   * resource === `mcpPublicUrl`), so its tokens verify on `/mcp`. The web
   * UI's login-session JWT (`webToken`) has none of the iss/aud/tenant/
   * API-version claims `/mcp` requires — never use it there.
   */
  readonly oauth: OAuthService;
  private readonly tenantIds: string[] = [];
  private readonly userIds: string[] = [];

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.adapterConfigs = new PtvAdapterConfigService(db);
    this.oauth = new OAuthService(db, config.jwtSecret, config.mcpPublicUrl, config.mcpPublicUrl);
  }

  /** Tracks a tenant created some other way (e.g. over HTTP) for cleanup. */
  trackTenant(tenantId: string): string {
    this.tenantIds.push(tenantId);
    return tenantId;
  }

  /** Tracks a user created some other way (e.g. `AuthService.register`) for cleanup. */
  trackUser(userId: string): string {
    this.userIds.push(userId);
    return userId;
  }

  /**
   * Inserts a tenant with slug `${slugPrefix}-${id}`. `v11` also configures
   * the v11 adapter (user-scoped OAuth credential) for the test environment.
   */
  async tenant(
    options: {
      name?: string;
      slugPrefix?: string;
      requireFourEyes?: boolean;
      v11?: { supportsWrite: boolean };
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await this.db.insert(tenants).values({
      id,
      name: options.name ?? 'Test Tenant',
      slug: `${options.slugPrefix ?? 'test'}-${id}`,
      ...(options.requireFourEyes === undefined
        ? {}
        : { requireFourEyes: options.requireFourEyes }),
    });
    this.trackTenant(id);
    if (options.v11) await this.configureV11(id, options.v11.supportsWrite);
    return id;
  }

  async configureV11(tenantId: string, supportsWrite: boolean): Promise<void> {
    await this.adapterConfigs.upsert(tenantId, 'test', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite,
      supportsDraftRead: false,
    });
  }

  /** Inserts a user (email `${id}@example.test`, no usable password). */
  async user(name = 'Test'): Promise<string> {
    const id = randomUUID();
    await this.db
      .insert(users)
      .values({ id, email: `${id}@example.test`, name, passwordHash: 'x' });
    return this.trackUser(id);
  }

  /** Registers and logs in a real user through `AuthService`. */
  async registeredUser(authService: AuthService, emailPrefix: string, name: string) {
    const email = `${emailPrefix}-${randomUUID()}@example.test`;
    const { userId } = await authService.register(email, name, 'correct-password');
    this.trackUser(userId);
    const session = await authService.login(email, 'correct-password');
    return { userId, email, session };
  }

  async addMembership(tenantId: string, userId: string, role: MembershipRole): Promise<void> {
    await withContext(this.db, { tenantId }, async (tx) => {
      await tx.insert(memberships).values({ tenantId, userId, role });
    });
  }

  /** The web UI's login-session JWT, for the REST API only (not `/mcp`). */
  webToken(userId: string): Promise<string> {
    return signAccessToken({ sub: userId }, this.config.jwtSecret);
  }

  /**
   * An MCP OAuth access token bound to one tenant in the test environment
   * with v11 reads and writes. MCP tools take tenant/environment from the
   * token's claims, not from their arguments, so acting in another tenant
   * means minting another token.
   */
  mcpToken(userId: string, tenantId: string): Promise<string> {
    return this.oauth.issueAccessToken(
      userId,
      'urn:ptv-mcp:test-client',
      'mcp',
      tenantId,
      'test',
      'v11',
      'v11',
    );
  }

  /** Deletes everything tracked so far (audit entries, proposals and campaigns included). */
  async cleanup(): Promise<void> {
    for (const tenantId of this.tenantIds) {
      await withContext(this.db, { tenantId }, async (tx) => {
        await tx.delete(auditEntries).where(eq(auditEntries.tenantId, tenantId));
        await tx.delete(proposals).where(eq(proposals.tenantId, tenantId));
        await tx.delete(reviewCampaigns).where(eq(reviewCampaigns.tenantId, tenantId));
        await tx.delete(memberships).where(eq(memberships.tenantId, tenantId));
      });
    }
    if (this.tenantIds.length > 0) {
      await this.db.delete(tenants).where(inArray(tenants.id, this.tenantIds));
    }
    if (this.userIds.length > 0) {
      await this.db.delete(users).where(inArray(users.id, this.userIds));
    }
    this.tenantIds.length = 0;
    this.userIds.length = 0;
  }
}

/** Starts `app` on a random local port and returns its base URL. */
export async function listenLocally(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a network address for the listening server');
  }
  return `http://127.0.0.1:${address.port}`;
}

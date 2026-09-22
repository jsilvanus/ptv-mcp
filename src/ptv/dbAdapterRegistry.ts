import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { PtvOrganizationCacheService } from '../db/ptvOrganizationCacheService.js';
import { withContext } from '../db/context.js';
import { memberships } from '../db/schema/index.js';
import { ROLE_RANK, type MembershipRole } from '../auth/rbac.js';
import {
  ConnectionNotFoundError,
  type UserPtvConnectionService,
} from '../credentials/userPtvConnectionService.js';
import {
  TenantEnvironmentNotFoundError,
  type TenantEnvironmentService,
} from '../credentials/tenantEnvironmentService.js';
import type {
  PtvAdapterConfigRecord,
  PtvAdapterConfigService,
} from '../credentials/ptvAdapterConfigService.js';
import { PtvV11Adapter } from './v11/adapter.js';
import { PtvV12Adapter } from './v12/adapter.js';
import type { PtvAdapter, PtvEnvironment } from './adapter.js';
import {
  PtvAdapterResolutionError,
  type PtvAdapterRegistry,
  type PtvAdapterResolutionRequest,
} from './registry.js';

/**
 * What an `AdapterFactory` gets handed once credentials are resolved —
 * `accessToken`/`credentials` are absent when no connection/credentials
 * exist for a read (v11's ordinary reads need none at all, per
 * docs/ptv-v11-notes.md) but always present for a write, since `resolve`
 * below enforces that before ever calling a factory.
 */
export interface AdapterConstructionOptions {
  environment: PtvEnvironment;
  canWrite: boolean;
  tenantId?: string;
  organizationCache?: PtvOrganizationCacheService;
  credential:
    | { scope: 'user'; accessToken?: string }
    | { scope: 'tenant'; credentials?: Record<string, unknown> };
}

export type AdapterFactory = (options: AdapterConstructionOptions) => PtvAdapter;

function v11Factory(options: AdapterConstructionOptions): PtvAdapter {
  if (options.credential.scope !== 'user') {
    throw new Error(
      `v11 adapter requires a user-scoped credential, got '${options.credential.scope}'`,
    );
  }
  return new PtvV11Adapter({
    environment: options.environment,
    canWrite: options.canWrite,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.organizationCache ? { organizationCache: options.organizationCache } : {}),
    ...(options.credential.accessToken ? { accessToken: options.credential.accessToken } : {}),
  });
}

function v12Factory(options: AdapterConstructionOptions): PtvAdapter {
  if (options.credential.scope !== 'tenant') {
    throw new Error(
      `v12 adapter requires a tenant-scoped credential, got '${options.credential.scope}'`,
    );
  }
  const apiKey = options.credential.credentials?.apiKey;
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new Error('v12 adapter requires an API key');
  }
  return new PtvV12Adapter({ environment: options.environment, apiKey });
}

const DEFAULT_ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  v11: v11Factory,
  v12: v12Factory,
};

/**
 * Real `PtvAdapterRegistry` implementation (Phase 3 Stream D): resolves
 * `(tenant, environment, operation, actingUser)` to a concrete, already-
 * credentialed adapter. Tenant/role authorization always runs before any
 * credential lookup — never replaced by it (docs/ptv-v11-notes.md's "Do
 * we still need tenant_id" section) — and is re-checked on every call,
 * never cached (docs/phase-plan.md's risk register: a user's PTV
 * connection outlives their tenant membership).
 *
 * `adapterFactories` is keyed by `api_version` and defaults to `{ v11:
 * ... }`; tests can pass extra entries (e.g. wrapping
 * `InMemoryPtvAdapter`) to exercise the tenant-scoped credential branch
 * without a second real adapter existing yet — see
 * dbAdapterRegistry.integration.test.ts.
 */
export class DbPtvAdapterRegistry implements PtvAdapterRegistry {
  private readonly adapterFactories: Record<string, AdapterFactory>;

  constructor(
    private readonly db: Database,
    private readonly configService: PtvAdapterConfigService,
    private readonly tenantEnvironmentService: TenantEnvironmentService,
    private readonly userConnectionService: UserPtvConnectionService,
    private readonly organizationCache?: PtvOrganizationCacheService,
    adapterFactories?: Record<string, AdapterFactory>,
  ) {
    this.adapterFactories = { ...DEFAULT_ADAPTER_FACTORIES, ...adapterFactories };
  }

  async resolve(request: PtvAdapterResolutionRequest): Promise<PtvAdapter> {
    const { tenantId, environment, apiVersion, operation, actingUserId } = request;

    // PTV v11 OUT is public published data. The MCP itself still requires
    // an authenticated user, but no tenant membership or PTV credential is
    // needed to perform a public read. Tenant-scoped resolution remains
    // mandatory for writes and for v12 reads because v12 requires an
    // integration-specific API key.
    if (tenantId === undefined) {
      if (operation !== 'read' || apiVersion !== 'v11') {
        throw new PtvAdapterResolutionError(
          'A tenant is required for this PTV connection',
          'not_authorized',
        );
      }
      const factory = this.adapterFactories.v11;
      if (!factory) {
        throw new PtvAdapterResolutionError(
          "No adapter factory registered for api_version 'v11'",
          'no_adapter_configured',
        );
      }
      return factory({ environment, canWrite: false, credential: { scope: 'user' } });
    }

    const minRole: MembershipRole = operation === 'write' ? 'publisher' : 'reader';
    const membership = await withContext(this.db, { tenantId, userId: actingUserId }, async (tx) =>
      tx.query.memberships.findFirst({
        where: and(eq(memberships.tenantId, tenantId), eq(memberships.userId, actingUserId)),
      }),
    );
    if (!membership || ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      throw new PtvAdapterResolutionError(
        `User ${actingUserId} is not authorized for '${operation}' on tenant ${tenantId}`,
        'not_authorized',
      );
    }

    const configs = await this.configService.list(tenantId);
    const inEnvironment = configs.filter(
      (c) => c.environment === environment && c.apiVersion === apiVersion,
    );
    if (inEnvironment.length === 0) {
      throw new PtvAdapterResolutionError(
        `No PTV adapter configured for tenant ${tenantId} in ${environment}/${apiVersion}`,
        'no_adapter_configured',
      );
    }

    const config = inEnvironment.find((c) =>
      operation === 'write' ? c.supportsWrite : c.supportsRead,
    );
    if (!config) {
      throw new PtvAdapterResolutionError(
        `No active PTV adapter for tenant ${tenantId}/${environment}/${apiVersion} supports '${operation}'`,
        'operation_not_supported',
      );
    }

    const factory = this.adapterFactories[config.apiVersion];
    if (!factory) {
      throw new PtvAdapterResolutionError(
        `No adapter factory registered for api_version '${config.apiVersion}'`,
        'no_adapter_configured',
      );
    }

    const credential = await this.resolveCredential(tenantId, actingUserId, config, operation);
    return factory({
      environment,
      tenantId,
      ...(this.organizationCache ? { organizationCache: this.organizationCache } : {}),
      canWrite: operation === 'write' && config.supportsWrite,
      credential,
    });
  }

  private async resolveCredential(
    tenantId: string,
    actingUserId: string,
    config: PtvAdapterConfigRecord,
    operation: PtvAdapterResolutionRequest['operation'],
  ): Promise<AdapterConstructionOptions['credential']> {
    if (config.credentialScope === 'user') {
      try {
        const { accessToken } = await this.userConnectionService.getDecryptedConnection(
          actingUserId,
          config.apiVersion,
          config.environment,
        );
        return { scope: 'user', accessToken };
      } catch (err) {
        if (err instanceof ConnectionNotFoundError) {
          if (operation === 'write') {
            throw new PtvAdapterResolutionError(
              `User ${actingUserId} has no active PTV connection for ${config.apiVersion}/${config.environment} — reconnect to PTV`,
              'credential_missing_or_expired',
            );
          }
          // Reads don't strictly need a credential for every adapter (v11's
          // ordinary GETs are unauthenticated) — let the adapter decide.
          return { scope: 'user' };
        }
        throw err;
      }
    }

    try {
      const credentials = await this.tenantEnvironmentService.getDecryptedCredentials(
        tenantId,
        config.environment,
        config.apiVersion,
      );
      return { scope: 'tenant', credentials };
    } catch (err) {
      if (err instanceof TenantEnvironmentNotFoundError) {
        if (operation === 'write') {
          throw new PtvAdapterResolutionError(
            `No credentials configured for tenant ${tenantId}, ${config.apiVersion}/${config.environment}`,
            'credential_missing_or_expired',
          );
        }
        return { scope: 'tenant' };
      }
      throw err;
    }
  }

  /**
   * Real, unauthenticated liveness check against v11 (its ordinary reads
   * need no credential — see docs/ptv-v11-notes.md) — reuses the same
   * `PtvV11Adapter.searchServices` every real caller goes through, rather
   * than a bespoke ping, so a passing check means the actual read path
   * works, not just that the host is reachable. Callers are expected to
   * poll this periodically (docs/phase-plan.md's Stream D scope) — the
   * polling loop itself lives wherever the process's scheduler does, not
   * here.
   */
  async checkV11Liveness(environment: PtvEnvironment): Promise<{ live: boolean; checkedAt: Date }> {
    const adapter = new PtvV11Adapter({ environment });
    try {
      await adapter.searchServices({ page: 1, pageSize: 1 });
      return { live: true, checkedAt: new Date() };
    } catch {
      return { live: false, checkedAt: new Date() };
    }
  }
}

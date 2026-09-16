import type { PtvAdapter, PtvEnvironment } from './adapter.js';

/**
 * The operations a caller might ask PtvAdapterRegistry to resolve an
 * adapter for. Kept coarse (read vs. write) rather than per-method, since
 * that's the granularity PtvAdapterConfig's `supports_read`/`supports_write`
 * flags actually govern.
 */
export type PtvOperation = 'read' | 'write';

export interface PtvAdapterResolutionRequest {
  tenantId: string;
  environment: PtvEnvironment;
  operation: PtvOperation;
  /**
   * Required even for tenant-scoped adapters, because tenant/role
   * authorization (is this user a Publisher for this tenant?) is always
   * checked before any credential lookup — see docs/ptv-v11-notes.md's
   * "Do we still need tenant_id" section. For a user-scoped adapter
   * (credentialScope: 'user'), this is also whose UserPtvConnection row
   * gets resolved.
   */
  actingUserId: string;
}

export class PtvAdapterResolutionError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'not_authorized'
      | 'no_adapter_configured'
      | 'operation_not_supported'
      | 'credential_missing_or_expired',
  ) {
    super(message);
    this.name = 'PtvAdapterResolutionError';
  }
}

/**
 * Resolution contract only — the real implementation (DB-backed lookups
 * against PtvAdapterConfig, TenantEnvironment, and UserPtvConnection,
 * plus the tenant/role authorization check) is Phase 3 Stream D. Defined
 * here in Phase 1 so Phase 2's adapters and Phase 4's MCP tools can be
 * built against a stable shape without waiting on Phase 3.
 */
export interface PtvAdapterRegistry {
  resolve(request: PtvAdapterResolutionRequest): Promise<PtvAdapter>;
}

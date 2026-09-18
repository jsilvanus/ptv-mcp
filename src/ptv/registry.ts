import type { PtvAdapter, PtvEnvironment } from './adapter.js';

/**
 * The operations a caller might ask PtvAdapterRegistry to resolve an
 * adapter for. Kept coarse (read vs. write) rather than per-method, since
 * that's the granularity PtvAdapterConfig's `supports_read`/`supports_write`
 * flags actually govern.
 */
export type PtvOperation = 'read' | 'write';

export interface PtvAdapterResolutionRequest {
  /**
   * Tenant whose configured PTV integration/credentials should be used.
   *
   * This is optional for public v11 OUT reads: v11 published OUT data is
   * public and does not require a tenant membership or credential. For
   * tenant-scoped operations (including v12 reads, whose API key is
   * integration-specific) it remains required.
   */
  tenantId?: string;
  environment: PtvEnvironment;
  operation: PtvOperation;
  /**
   * The authenticated MCP user. It is still required for the MCP session,
   * even when the underlying PTV read is public.
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
 * Resolution contract only — the real implementation resolves either a
 * tenant-scoped PTV integration or, for public v11 OUT reads, the
 * credential-free public adapter.
 */
export interface PtvAdapterRegistry {
  resolve(request: PtvAdapterResolutionRequest): Promise<PtvAdapter>;
}

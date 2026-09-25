import type { PtvAdapter, PtvEnvironment } from '../ptv/adapter.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';

/**
 * Read tools may omit tenantId when they are using PTV v11's public OUT
 * interface. If tenantId is present, it identifies the tenant/integration
 * whose PTV configuration is being used; it does NOT limit which public
 * PTV organisation may be queried.
 */
export interface ToolContext {
  tenantId: string;
  environment: PtvEnvironment;
  readApiVersion?: string;
  writeApiVersion?: string | undefined;
  /** @deprecated Use readApiVersion/writeApiVersion. Kept for existing test/tool contexts during migration. */
  apiVersion?: string;
  actingUserId: string;
}

/**
 * Context for read tools. `tenantId` is absent on a public connection (no
 * organisation chosen): the registry then serves PTV v11's public,
 * published-only data, with no drafts and no tenant configuration.
 */
export type ReadToolContext = Omit<ToolContext, 'tenantId'> & { tenantId?: string };

export class WriteApiNotSelectedError extends Error {
  constructor() {
    super(
      'No write API version is selected for this MCP connection. This connection is read-only; reconnect and select a write API version to use PTV write tools.',
    );
    this.name = 'WriteApiNotSelectedError';
  }
}

/** The adapter for reading PTV with the connection's read API version (v11 by default). */
export function resolveReadAdapter(
  registry: PtvAdapterRegistry,
  ctx: ReadToolContext,
): Promise<PtvAdapter> {
  return registry.resolve({
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    environment: ctx.environment,
    apiVersion: ctx.readApiVersion ?? ctx.apiVersion ?? 'v11',
    operation: 'read',
    actingUserId: ctx.actingUserId,
  });
}

/**
 * The write-capable adapter for the connection's write API version; the
 * registry refuses it below Publisher. Throws WriteApiNotSelectedError on
 * a read-only connection.
 */
export function resolveWriteAdapter(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
): Promise<PtvAdapter> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  return registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.writeApiVersion,
    operation: 'write',
    actingUserId: ctx.actingUserId,
  });
}

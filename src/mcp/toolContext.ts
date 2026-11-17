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

/**
 * A call reaches outside what its MCP connection was authorised for: another
 * environment, or another organisation than the token's `tenant_id` /
 * `environment` claims name. Refused, never silently switched.
 */
export class GrantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantScopeError';
  }
}

/**
 * Refuses a proposal that belongs to another environment than the MCP
 * connection's grant. Only MCP tool calls pass `enforceGrantEnvironment`
 * (see proposalQueue.ts); the web UI resolves proposals of any environment
 * the user has a role for, using its own token.
 */
export function requireProposalInGrantEnvironment(
  grantEnvironment: PtvEnvironment,
  proposalEnvironment: PtvEnvironment,
): void {
  if (proposalEnvironment !== grantEnvironment) {
    throw new GrantScopeError(
      `This connection is authorised for ${grantEnvironment}; the proposal belongs to ${proposalEnvironment}. Reconnect for that environment.`,
    );
  }
}

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

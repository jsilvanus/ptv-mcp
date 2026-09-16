import type { PtvEnvironment } from '../ptv/adapter.js';

/**
 * Every MCP tool call needs to say which tenant/environment it's acting
 * for and who's acting — there's no persistent per-connection session to
 * infer this from (the HTTP transport is stateless; see mcp/httpTransport.ts),
 * so callers pass it on every call, same as the resolved role is
 * re-checked on every call in PtvAdapterRegistry.resolve().
 */
export interface ToolContext {
  tenantId: string;
  environment: PtvEnvironment;
  actingUserId: string;
}

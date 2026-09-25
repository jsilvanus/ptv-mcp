import type { FastifyRequest } from 'fastify';
import type { PtvEnvironment } from '../ptv/adapter.js';
import type { ToolContext } from '../mcp/toolContext.js';

/** Query/body fields a web UI route may pass to pick the PTV environment and read API. */
export interface ContextQuery {
  environment?: string;
  readApiVersion?: string;
}

export function isPtvEnvironment(value: unknown): value is PtvEnvironment {
  return value === 'test' || value === 'production';
}

/**
 * The `ToolContext` a tenant route hands to the shared domain functions
 * (the same ones behind the MCP tools). Must run after `authenticate` and
 * `requireRole`: the tenant comes from the route and the acting user from
 * the login session. Anything but `production` means the test environment.
 */
export function toolContextFromRequest(
  request: FastifyRequest,
  query: ContextQuery = {},
): ToolContext {
  const { tenantId } = request.params as { tenantId: string };
  return {
    tenantId,
    environment: query.environment === 'production' ? 'production' : 'test',
    ...(query.readApiVersion ? { readApiVersion: query.readApiVersion } : {}),
    actingUserId: request.userId!,
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PtvAdapterRegistry, PtvAdapterResolutionRequest } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { Database } from '../db/client.js';
import { resolveMembershipRole } from '../auth/rbac.js';
import type { ProposalService } from '../proposals/proposalService.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';
import { ReviewService } from '../reviews/reviewService.js';
import { registerGuides, SERVER_INSTRUCTIONS } from './guides.js';
import { useToolMetadata } from './toolAnnotations.js';
import { registerResources } from './resources.js';
import { registerProposalTools } from './tools/proposalTools.js';
import { registerReadTools } from './tools/readTools.js';
import { registerReviewTools } from './tools/reviewTools.js';
import { toolRegistrar, type ToolDeps } from './tools/shared.js';

export { AuthenticationRequiredError } from './tools/shared.js';

export interface McpServerDeps {
  db: Database;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
  validator: ChangeValidator;
  proposalService: ProposalService;
  publicUrl?: string;
}

/**
 * Caches an async lookup for the lifetime of one `createMcpServer()` call,
 * i.e. one HTTP request. A failed lookup is dropped rather than reused.
 */
function memoize<A extends unknown[], R>(
  key: (...args: A) => string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (...args) => {
    const k = key(...args);
    let result = cache.get(k);
    if (!result) {
      result = fn(...args);
      cache.set(k, result);
      result.catch(() => cache.delete(k));
    }
    return result;
  };
}

/**
 * Builds the MCP tool surface (Phase 4) over the given dependencies. A
 * fresh server is expected per-request in the stateless HTTP transport
 * (mcp/httpTransport.ts) — construction here is cheap (just closures),
 * the real state (DB connections, adapters) lives in `deps`.
 *
 * Tools live in ./tools/ by area and resources in ./resources.ts; the
 * registration order below is the order clients list them in.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const { db, auditService, validator, proposalService } = deps;
  // One server per request (see httpTransport.ts), so these memos only
  // span one request. Keys hold every argument, so nothing is shared
  // between tenants or users.
  const resolveRole = memoize(
    (tenantId: string, userId: string) => `${tenantId}:${userId}`,
    (tenantId: string, userId: string) => resolveMembershipRole(db, tenantId, userId),
  );
  const registry: PtvAdapterRegistry = {
    resolve: memoize(
      (request: PtvAdapterResolutionRequest) => JSON.stringify(Object.entries(request).sort()),
      (request: PtvAdapterResolutionRequest) => deps.registry.resolve(request),
    ),
  };
  const tenantService = new TenantService(db, auditService);
  const toolDeps: ToolDeps = {
    proposalService,
    resolveRole,
    registry,
    auditService,
    reviewService: new ReviewService(db),
    listMembers: (tenantId: string) => tenantService.listMembers(tenantId),
    validator,
    requireFourEyes: (tenantId: string) => tenantRequiresFourEyes(db, tenantId),
  };

  const server = new McpServer(
    { name: 'ptv-mcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  useToolMetadata(server);
  registerGuides(server);

  const tool = toolRegistrar(server, deps.publicUrl);
  registerReadTools(tool, registry);
  registerProposalTools(tool, toolDeps);
  registerReviewTools(tool, toolDeps);
  registerResources(server, registry);

  return server;
}

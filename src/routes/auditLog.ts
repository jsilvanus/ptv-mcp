import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { AuditService } from '../audit/auditService.js';
import { createAuthenticate, createRequireRole } from '../auth/rbac.js';

export interface AuditLogRoutesOptions {
  auditService: AuditService;
  jwtSecret: string;
  db: Database;
}

interface AuditLogQuery {
  resourceType?: string;
  correlationId?: string;
  limit?: string;
}

/**
 * Phase 5 Stream C's backend half — nothing exposed this before (only the
 * MCP tool layer and internal `AuditService` existed). Gated to Tenant
 * Admin only, matching docs/plan.md's role model ("tarkastella
 * audit-lokeja" is a Tenant Admin capability, not listed for
 * Reader/Editor/Publisher) — the doc also flags the `prompt`/`before_state`/
 * `after_state` fields as potentially needing tighter access even within
 * Tenant Admin, which this route doesn't yet implement (see EXECUTION_LOG.md).
 */
export async function auditLogRoutes(
  app: FastifyInstance,
  options: AuditLogRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireTenantAdmin = createRequireRole(options.db, 'tenant_admin');

  app.get<{ Querystring: AuditLogQuery }>(
    '/tenants/:tenantId/audit-entries',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const { resourceType, correlationId, limit } = request.query;
      return options.auditService.listForTenant(tenantId, {
        ...(resourceType ? { resourceType } : {}),
        ...(correlationId ? { correlationId } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
    },
  );
}

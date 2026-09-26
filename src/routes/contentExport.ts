import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { AuditService } from '../audit/auditService.js';
import { createAuthenticate, createRequireRole } from '../auth/rbac.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import { resolveReadAdapter } from '../mcp/toolContext.js';
import { toolContextFromRequest, type ContextQuery } from './context.js';
import { collectContent, contentSheets } from '../export/contentExport.js';
import { buildXlsx } from '../export/xlsx.js';

export interface ContentExportRoutesOptions {
  db: Database;
  jwtSecret: string;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
}

interface ContentExportQuery extends ContextQuery {
  organizationId?: string;
  includeSubOrganisations?: string;
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * `GET /tenants/:tenantId/ptv/content-export`: an organisation's PTV
 * content and automated check findings as an Excel file, the content
 * report DVV reviews before issuing IN-API production credentials
 * (src/export/contentExport.ts). Contributor+ (Ehdottaja); audited. An
 * unknown organisation is a 404 (src/routes/errorHandler.ts).
 */
export async function contentExportRoutes(
  app: FastifyInstance,
  options: ContentExportRoutesOptions,
): Promise<void> {
  const preHandler = [
    createAuthenticate(options.jwtSecret),
    createRequireRole(options.db, 'contributor'),
  ];

  app.get<{ Querystring: ContentExportQuery }>(
    '/tenants/:tenantId/ptv/content-export',
    { preHandler },
    async (request, reply) => {
      const { organizationId } = request.query;
      if (!organizationId) return reply.badRequest('Give organizationId');
      const ctx = toolContextFromRequest(request, request.query);
      const includeSubOrganisations = request.query.includeSubOrganisations !== 'false';
      const adapter = await resolveReadAdapter(options.registry, ctx);
      const content = await collectContent(adapter, organizationId, includeSubOrganisations);
      const file = buildXlsx(contentSheets(content));
      await options.auditService.record({
        tenantId: ctx.tenantId,
        userId: ctx.actingUserId,
        action: 'ExportContent',
        resourceType: 'Organization',
        resourceId: organizationId,
        environment: ctx.environment,
        afterState: {
          organisations: content.organisations.length,
          services: content.services.length,
          channels: content.channels.length,
          connections: content.connections.length,
        },
        result: 'Exported',
      });
      const date = content.readAt.slice(0, 10);
      return reply
        .header('content-type', XLSX_TYPE)
        .header(
          'content-disposition',
          `attachment; filename="ptv-sisalto-${organizationId}-${ctx.environment}-${date}.xlsx"`,
        )
        .send(Buffer.from(file.buffer, file.byteOffset, file.byteLength));
    },
  );
}

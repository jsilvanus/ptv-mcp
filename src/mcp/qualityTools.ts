import { resolveReadAdapter } from './toolContext.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { Service, ServiceChannel } from '../ptv/domain.js';
import {
  checkChannel,
  checkConnection,
  checkService,
  type QualityFinding,
  type QualityReport,
} from '../quality/contentChecks.js';
import { loadGeneralDescription } from '../quality/generalDescriptionContext.js';
import { ServiceNotFoundError } from './proposeChanges.js';
import { ChannelNotFoundError } from './channelProposal.js';
import type { ReadToolContext } from './toolContext.js';

export interface QualityCheckResult {
  kind: 'service' | 'channel';
  id: string;
  name: string | null;
  report: QualityReport;
}

/**
 * `ptv_check_quality`: reads a service or channel and runs the
 * deterministic content checks (src/quality/contentChecks.ts). A service
 * is checked against its organisation's names, with its connections'
 * extra info (fields `connections.<channelId>.<field>`); a channel against
 * its connections.
 */
export async function checkQuality(
  registry: PtvAdapterRegistry,
  ctx: ReadToolContext,
  kind: 'service' | 'channel',
  id: string,
): Promise<QualityCheckResult> {
  const adapter = await resolveReadAdapter(registry, ctx);
  if (kind === 'service') {
    const service: Service | null = await adapter.getService(id);
    if (!service) throw new ServiceNotFoundError(id);
    const org = await adapter.getOrganisation(service.organizationId).catch(() => null);
    const connections = await adapter.getConnectionsFor(id).catch(() => []);
    const generalDescription = await loadGeneralDescription(adapter, service.generalDescriptionId);
    const findings: QualityFinding[] = [
      ...checkService(service, {
        ...(org ? { organisationNames: org.names } : {}),
        ...(generalDescription ? { generalDescription } : {}),
      }).findings,
      ...connections.flatMap((connection) =>
        checkConnection(connection).findings.map((finding) => ({
          ...finding,
          field: `connections.${connection.channelId}.${finding.field}`,
        })),
      ),
    ];
    return {
      kind,
      id,
      name: service.names.fi ?? Object.values(service.names)[0] ?? null,
      report: {
        findings,
        errors: findings.filter((finding) => finding.severity === 'error').length,
        warnings: findings.filter((finding) => finding.severity === 'warning').length,
      },
    };
  }
  const channel: ServiceChannel | null = await adapter.getChannel(id);
  if (!channel) throw new ChannelNotFoundError(id);
  const connections = await adapter.getConnectionsFor(id).catch(() => undefined);
  return {
    kind,
    id,
    name: channel.names.fi ?? Object.values(channel.names)[0] ?? null,
    report: checkChannel(channel, connections ? { connectedServiceCount: connections.length } : {}),
  };
}

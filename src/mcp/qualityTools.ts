import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { Service, ServiceChannel } from '../ptv/domain.js';
import { checkChannel, checkService, type QualityReport } from '../quality/contentChecks.js';
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
 * is checked against its organisation's names; a channel against its
 * connections.
 */
export async function checkQuality(
  registry: PtvAdapterRegistry,
  ctx: ReadToolContext,
  kind: 'service' | 'channel',
  id: string,
): Promise<QualityCheckResult> {
  const adapter = await registry.resolve({
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    environment: ctx.environment,
    apiVersion: ctx.readApiVersion ?? ctx.apiVersion ?? 'v11',
    operation: 'read',
    actingUserId: ctx.actingUserId,
  });
  if (kind === 'service') {
    const service: Service | null = await adapter.getService(id);
    if (!service) throw new ServiceNotFoundError(id);
    const org = await adapter.getOrganisation(service.organizationId).catch(() => null);
    return {
      kind,
      id,
      name: service.names.fi ?? Object.values(service.names)[0] ?? null,
      report: checkService(service, org ? { organisationNames: org.names } : {}),
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

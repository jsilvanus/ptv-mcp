import type { Service } from '../../domain.js';
import type { V11ServiceWire } from '../wireModel.js';
import { toCodeListEntries, toLocalizedText, toPublishingStatus } from './common.js';

const SERVICE_TYPE_MAP: Record<string, Service['serviceType']> = {
  Service: 'Service',
  ProfessionalQualification: 'ProfessionalQualification',
  PermitOrObligation: 'PermitOrObligation',
};

function toServiceType(wireType: string): Service['serviceType'] {
  const mapped = SERVICE_TYPE_MAP[wireType];
  if (!mapped) throw new Error(`Unknown v11 service type: ${wireType}`);
  return mapped;
}

/**
 * v11 models a service's organizations as a list of {organization, roleType}
 * pairs (Responsible, Producer, ...) — see docs/ptv-v11-notes.md. The domain
 * model wants a single `organizationId`, so this picks the "Responsible"
 * entry, falling back to the first entry if none is explicitly marked
 * (verified against real data that "Responsible" is present in practice,
 * but not asserted as always guaranteed by the schema).
 */
function toOrganizationId(wire: V11ServiceWire): string {
  const responsible = wire.organizations.find((org) => org.roleType === 'Responsible');
  const fallback = wire.organizations[0];
  const chosen = responsible ?? fallback;
  if (!chosen) {
    throw new Error(`Service ${wire.id} has no organizations listed`);
  }
  return chosen.organization.id;
}

export function serviceWireToDomain(wire: V11ServiceWire): Service {
  return {
    id: wire.id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: toOrganizationId(wire),
    serviceType: toServiceType(wire.type),
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.serviceNames, ['Name']),
    summaries: toLocalizedText(wire.serviceDescriptions, ['Summary']),
    descriptions: toLocalizedText(wire.serviceDescriptions, ['Description']),
    serviceClasses: toCodeListEntries(wire.serviceClasses),
    ontologyTerms: toCodeListEntries(wire.ontologyTerms),
    targetGroups: toCodeListEntries(wire.targetGroups),
    lifeEvents: toCodeListEntries(wire.lifeEvents),
    industrialClasses: toCodeListEntries(wire.industrialClasses),
    languages: wire.languages,
    ...(wire.generalDescriptionId ? { generalDescriptionId: wire.generalDescriptionId } : {}),
    serviceChannelIds: wire.serviceChannels.map((relation) => relation.serviceChannel.id),
    modifiedAt: wire.modified,
  };
}

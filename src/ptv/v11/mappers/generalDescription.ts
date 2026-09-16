import type { GeneralDescription, ServiceType } from '../../domain.js';
import type { V11GeneralDescriptionWire } from '../wireModel.js';
import { toCodeListEntries, toLocalizedText, toPublishingStatus } from './common.js';

const SERVICE_TYPE_MAP: Record<string, ServiceType> = {
  Service: 'Service',
  ProfessionalQualification: 'ProfessionalQualification',
  PermitOrObligation: 'PermitOrObligation',
};

function toServiceType(wireType: string): ServiceType {
  const mapped = SERVICE_TYPE_MAP[wireType];
  if (!mapped) throw new Error(`Unknown v11 general description service type: ${wireType}`);
  return mapped;
}

export function generalDescriptionWireToDomain(
  wire: V11GeneralDescriptionWire,
): GeneralDescription {
  return {
    id: wire.id,
    serviceType: toServiceType(wire.type),
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.names, ['Name']),
    descriptions: toLocalizedText(wire.descriptions, ['Description', 'Summary']),
    serviceClasses: toCodeListEntries(wire.serviceClasses),
    ontologyTerms: toCodeListEntries(wire.ontologyTerms),
    targetGroups: toCodeListEntries(wire.targetGroups),
    lifeEvents: toCodeListEntries(wire.lifeEvents),
    industrialClasses: toCodeListEntries(wire.industrialClasses),
    modifiedAt: wire.modified,
  };
}

import type { Organization } from '../../domain.js';
import type { V11OrganizationWire } from '../wireModel.js';
import { toLocalizedText, toPublishingStatus } from './common.js';

export function organizationWireToDomain(wire: V11OrganizationWire): Organization {
  return {
    id: wire.id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    ...(wire.parentOrganizationId ? { parentOrganizationId: wire.parentOrganizationId } : {}),
    ...(wire.businessCode ? { businessCode: wire.businessCode } : {}),
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.organizationNames, ['Name']),
    modifiedAt: wire.modified,
  };
}

import type { Organization } from '../../domain.js';
import type { V12OrganizationWire } from '../wireModel.js';
import { contentIdOf, modifiedAtField, namesOf, normalizePublishingStatus } from './common.js';

export function mapV12Organization(wire: V12OrganizationWire): Organization {
  const id = contentIdOf(wire, 'organization');
  const parentOrganizationId =
    wire.parentOrganizationContentId ??
    wire.parentOrganizationId ??
    wire.parentOrganization?.contentId ??
    wire.parentOrganization?.id;
  const businessCode = wire.businessCode ?? wire.businessId;
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    ...(parentOrganizationId ? { parentOrganizationId } : {}),
    ...(businessCode ? { businessCode } : {}),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: namesOf(wire),
    ...modifiedAtField(wire),
  };
}

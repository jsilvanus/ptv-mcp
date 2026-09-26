import type { Service } from '../../domain.js';
import type { V12ServiceWire } from '../wireModel.js';
import {
  codeEntries,
  contentIdOf,
  descriptionsOf,
  ids,
  languagesOf,
  localized,
  modifiedAtField,
  namesOf,
  normalizePublishingStatus,
  normalizeServiceType,
  organizationIdOf,
} from './common.js';

/**
 * Map the v12 wire representation into the stable PTV domain model.
 *
 * v12 deliberately changed localized content from v11's array of
 * {language,value} records to languageVersions, e.g.
 * { fi: { name, summary, description }, sv: { ... } }.
 * The old mapper treated those nested objects as non-string values and
 * consequently discarded every localized field.
 */
export function mapV12Service(wire: V12ServiceWire): Service {
  const id = contentIdOf(wire, 'service');
  const generalDescriptionId = wire.generalDescriptionContentId ?? wire.generalDescriptionId;
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: organizationIdOf(wire),
    serviceType: normalizeServiceType(wire.serviceType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: namesOf(wire),
    summaries: localized(wire.summaries ?? wire.summary ?? wire.languageVersions, 'summary'),
    descriptions: descriptionsOf(wire),
    serviceClasses: codeEntries(wire.serviceClasses),
    ontologyTerms: codeEntries(wire.ontologyTerms),
    targetGroups: codeEntries(wire.targetGroups),
    lifeEvents: codeEntries(wire.lifeEvents),
    industrialClasses: codeEntries(wire.industrialClasses),
    languages: languagesOf(wire),
    ...(generalDescriptionId ? { generalDescriptionId } : {}),
    serviceChannelIds: ids(wire.serviceChannelIds ?? wire.serviceChannels),
    ...modifiedAtField(wire),
  };
}

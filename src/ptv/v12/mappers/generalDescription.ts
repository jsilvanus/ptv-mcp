import type { GeneralDescription } from '../../domain.js';
import type { V12GeneralDescriptionWire } from '../wireModel.js';
import {
  codeEntries,
  contentIdOf,
  descriptionsOf,
  modifiedAtField,
  namesOf,
  normalizePublishingStatus,
  normalizeServiceType,
} from './common.js';

export function mapV12GeneralDescription(wire: V12GeneralDescriptionWire): GeneralDescription {
  return {
    id: contentIdOf(wire, 'general description'),
    serviceType: normalizeServiceType(wire.serviceType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: namesOf(wire),
    descriptions: descriptionsOf(wire),
    serviceClasses: codeEntries(wire.serviceClasses),
    ontologyTerms: codeEntries(wire.ontologyTerms),
    targetGroups: codeEntries(wire.targetGroups),
    lifeEvents: codeEntries(wire.lifeEvents),
    industrialClasses: codeEntries(wire.industrialClasses),
    ...modifiedAtField(wire),
  };
}

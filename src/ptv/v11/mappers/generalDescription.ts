import type { GeneralDescription } from '../../domain.js';
import type { V11GeneralDescriptionWire } from '../wireModel.js';
import { toCodeListEntries, toLocalizedText, toPublishingStatus, toServiceType } from './common.js';

function textsByLanguage(wire: V11GeneralDescriptionWire): Partial<Record<string, string[]>> {
  const texts: Partial<Record<string, string[]>> = {};
  for (const item of wire.descriptions ?? []) {
    if (item.value) (texts[item.language] ??= []).push(item.value);
  }
  return texts;
}

export function generalDescriptionWireToDomain(
  wire: V11GeneralDescriptionWire,
): GeneralDescription {
  return {
    id: wire.id,
    serviceType: toServiceType(wire.type, 'general description service'),
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.names, ['Name']),
    descriptions: toLocalizedText(wire.descriptions, ['Description', 'Summary']),
    texts: textsByLanguage(wire),
    serviceClasses: toCodeListEntries(wire.serviceClasses),
    ontologyTerms: toCodeListEntries(wire.ontologyTerms),
    targetGroups: toCodeListEntries(wire.targetGroups),
    lifeEvents: toCodeListEntries(wire.lifeEvents),
    industrialClasses: toCodeListEntries(wire.industrialClasses),
    modifiedAt: wire.modified,
  };
}

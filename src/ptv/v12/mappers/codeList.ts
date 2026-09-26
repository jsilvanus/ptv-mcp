import type { CodeListEntry } from '../../domain.js';
import { firstString, localized } from './common.js';

export const V12_REFERENCE_CODE_LIST_PATHS: Record<string, string> = {
  countries: '/api/v12/country-codes',
  industrialClasses: '/api/v12/industrial-classes',
  languages: '/api/v12/language-codes',
  lifeEvents: '/api/v12/life-events',
  municipalities: '/api/v12/municipality-codes',
  ontologyTerms: '/api/v12/ontology-terms',
  postalCodes: '/api/v12/postal-codes',
  regions: '/api/v12/region-codes',
  serviceClasses: '/api/v12/service-classes',
  targetGroups: '/api/v12/target-groups',
  wellbeingServicesCounties: '/api/v12/wellbeing-services-county-codes',
};

export function referenceCodeToDomain(value: unknown): CodeListEntry {
  if (typeof value === 'string') return { code: value, names: {} };
  if (!value || typeof value !== 'object') return { names: {} };
  const item = value as Record<string, unknown>;
  const code = firstString(item.code, item.contentId, item.id, item.value);
  return {
    ...(code ? { code } : {}),
    ...(typeof item.uri === 'string' ? { uri: item.uri } : {}),
    names: localized(item.names ?? item.name ?? item.languageVersions, 'name'),
  };
}

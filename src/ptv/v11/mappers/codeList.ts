import type { CodeListEntry } from '../../domain.js';
import type { V11ReferenceCodeItem } from '../wireModel.js';
import { toLocalizedText } from './common.js';

export function referenceCodeWireToDomain(wire: V11ReferenceCodeItem): CodeListEntry {
  return {
    code: wire.code,
    names: toLocalizedText(wire.names),
  };
}

/**
 * v11 only exposes standalone reference code lists for these — unlike
 * v12, classification codes (service classes, ontology terms, target
 * groups, life events, industrial classes) have no standalone list
 * endpoint in v11 and are only ever seen embedded on actual entities.
 * `PtvV11Adapter.listCodes` supports exactly this set; anything else
 * throws a clear "not supported by v11" error rather than returning an
 * empty list that could be mistaken for "no codes exist."
 */
export const V11_REFERENCE_CODE_LIST_PATHS: Record<string, string> = {
  languages: '/api/v11/CodeList/GetLanguageCodes',
  countries: '/api/v11/CodeList/GetCountryCodes',
  municipalities: '/api/v11/CodeList/GetMunicipalityCodes',
  postalCodes: '/api/v11/CodeList/GetPostalCodes',
};

import type { CodeListEntry } from '../api/types';

/** Finnish labels for the service/channel fields a proposal can touch. */
export const FIELD_LABELS: Record<string, string> = {
  names: 'Nimi',
  summaries: 'Tiivistelmä',
  descriptions: 'Kuvaus',
  serviceClasses: 'Palveluluokat',
  ontologyTerms: 'Asiasanat',
  targetGroups: 'Kohderyhmät',
  lifeEvents: 'Elämäntilanteet',
  industrialClasses: 'Toimialaluokat',
  languages: 'Kielet',
  publishingStatus: 'Julkaisutila',
  serviceType: 'Palvelutyyppi',
  generalDescriptionId: 'Pohjakuvaus',
  serviceChannelIds: 'Asiointikanavat',
  channelType: 'Asiointikanavan tyyppi',
  isVisibleForAll: 'Yhteiskäyttöisyys',
  urls: 'Verkko-osoite',
  webPages: 'Verkkosivut',
  phoneNumbers: 'Puhelinnumerot',
  supportPhones: 'Käytön tuki: puhelin',
  supportEmails: 'Käytön tuki: sähköposti',
  emails: 'Sähköpostiosoitteet',
  serviceHours: 'Palveluajat',
  addresses: 'Osoitteet',
  deliveryAddresses: 'Lomakkeen toimitusosoitteet',
  formIdentifiers: 'Lomaketunnus',
  formFiles: 'Lomaketiedostot',
  requiresAuthentication: 'Vaatii tunnistautumisen',
  requiresSignature: 'Vaatii allekirjoituksen',
  signatureQuantity: 'Allekirjoitusten määrä',
  accessibility: 'Saavutettavuus',
  organizationId: 'Organisaatio',
  serviceIds: 'Liitettävät palvelut',
  channelId: 'Asiointikanava',
  chargeType: 'Maksullisuus',
  chargeDescriptions: 'Maksullisuuden lisätieto',
};

export const CODE_LIST_FIELDS = [
  'serviceClasses',
  'ontologyTerms',
  'targetGroups',
  'lifeEvents',
  'industrialClasses',
] as const;

const LANGUAGE_LABELS: Record<string, string> = { fi: 'suomi', sv: 'ruotsi', en: 'englanti' };

/** "Nimi (suomi)" for `names.fi`, the plain label otherwise. */
export function fieldLabel(field: string): string {
  const [base, language] = field.split('.');
  const label = FIELD_LABELS[base ?? field] ?? field;
  return language ? `${label} (${LANGUAGE_LABELS[language] ?? language})` : label;
}

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language;
}

/** "P11.6 Seurakunnat…" — code and Finnish (or any) name, falling back to the uri. */
export function codeEntryLabel(entry: CodeListEntry): string {
  const name = entry.names?.fi ?? Object.values(entry.names ?? {})[0];
  const id = entry.code ?? entry.uri ?? '?';
  return name ? `${entry.code ? `${entry.code} ` : ''}${name}` : id;
}

export function codeEntryKey(entry: CodeListEntry): string {
  return entry.uri ?? entry.code ?? JSON.stringify(entry);
}

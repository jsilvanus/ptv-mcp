import type { LocalizedText } from '../ptv/domain.js';
import type { ProposalKind } from '../proposals/proposalService.js';
import { formatValue, languageRank } from '../format/ptvFormat.js';
import { PROPOSAL_KINDS } from './proposalKinds.js';
import type { ServiceDiffEntry } from './proposeChanges.js';

export { formatValue };

/**
 * The manual-publishing sheet for an approved-and-exported proposal: every
 * field to enter in PTV's own UI, in the UI's order and with its Finnish
 * label, the values formatted as PTV shows them (times 9.00, dates
 * 24.12.2026), plus the steps. Built from the proposal's diff, so it
 * covers the structured fields (hours, phones, addresses, classes) too.
 */
export interface ManualPublishSheet {
  action: 'update' | 'create';
  /** e.g. "Asiointikanava: Palvelupaikka". */
  target: string;
  /** The service or channel to edit; null until a new one is created. */
  ptvId: string | null;
  name: string | null;
  /** Language versions to publish. */
  languages: string[];
  steps: string[];
  fields: ManualPublishField[];
}

export interface ManualPublishField {
  /** Domain field, e.g. "phoneNumbers". */
  field: string;
  /** PTV UI label, e.g. "Puhelinnumerot". */
  label: string;
  language?: string;
  before?: string;
  /** Ready to copy; "(tyhjä)" means clear the field. */
  after: string;
}

/** PTV UI labels in the order the edit form shows them. */
const FIELD_LABELS: [field: string, label: string][] = [
  ['publishingStatus', 'Julkaisutila'],
  ['serviceType', 'Palvelun tyyppi'],
  ['generalDescriptionId', 'Pohjakuvaus'],
  ['names', 'Nimi'],
  ['alternativeNames', 'Vaihtoehtoinen nimi'],
  ['alternativeNameShownIn', 'Käytä vaihtoehtoista nimeä ensisijaisena nimenä'],
  ['businessCode', 'Y-tunnus'],
  ['summaries', 'Tiivistelmä'],
  ['descriptions', 'Kuvaus'],
  ['languages', 'Kielet'],
  ['organizationType', 'Organisaatiotyyppi'],
  ['area', 'Aluetieto'],
  ['municipality', 'Kunta'],
  ['isVisibleForAll', 'Yhteiskäyttöisyys'],
  ['urls', 'Verkko-osoite'],
  ['requiresAuthentication', 'Vaatii tunnistautumisen'],
  ['requiresSignature', 'Vaatii allekirjoituksen'],
  ['signatureQuantity', 'Allekirjoitusten määrä'],
  ['accessibility', 'Saavutettavuus'],
  ['formIdentifiers', 'Lomaketunnus'],
  ['formFiles', 'Lomakkeen verkko-osoitteet'],
  ['deliveryAddresses', 'Toimitustiedot'],
  ['addresses', 'Osoitteet'],
  ['phoneNumbers', 'Puhelinnumerot'],
  ['emails', 'Sähköposti'],
  ['webPages', 'Verkkosivut'],
  ['supportPhones', 'Käytön tuki: puhelin'],
  ['supportEmails', 'Käytön tuki: sähköposti'],
  ['serviceHours', 'Palveluajat'],
  ['chargeType', 'Maksullisuus'],
  ['chargeDescriptions', 'Maksullisuuden lisätieto'],
  ['targetGroups', 'Kohderyhmä'],
  ['serviceClasses', 'Palveluluokka'],
  ['ontologyTerms', 'Asiasanat'],
  ['lifeEvents', 'Elämäntilanne'],
  ['industrialClasses', 'Toimiala'],
  ['serviceChannelIds', 'Liitokset: asiointikanavat'],
  ['serviceIds', 'Liitokset: palvelut'],
];
const FIELD_ORDER = new Map(FIELD_LABELS.map(([field], index) => [field, index]));
const LABELS = new Map(FIELD_LABELS);
/** Stated in the steps instead of as fields. */
const STEP_FIELDS = new Set(['channelType', 'organizationId', 'parentOrganizationId', 'id']);

export function buildManualPublishSheet(input: {
  kind: ProposalKind;
  diff: ServiceDiffEntry[];
  ptvId: string | null;
  names: LocalizedText;
  languages: string[];
  channelType?: string;
  organizationId?: string;
  /** connection_update: the connected channel (ptvId is the service). */
  channelId?: string;
}): ManualPublishSheet {
  const { creates, sheet } = PROPOSAL_KINDS[input.kind];
  const target = sheet.target(input.channelType);
  const name = input.names.fi ?? Object.values(input.names).find(Boolean) ?? null;
  const fields = input.diff
    .map((entry) => sheetField(entry, sheet.channel))
    .filter((field): field is ManualPublishField => field !== null)
    .sort(
      (a, b) =>
        (FIELD_ORDER.get(a.field) ?? 99) - (FIELD_ORDER.get(b.field) ?? 99) ||
        languageRank(a.language) - languageRank(b.language),
    );
  const languages = [...input.languages].sort((a, b) => languageRank(a) - languageRank(b));

  return {
    action: creates ? 'create' : 'update',
    target,
    ptvId: input.ptvId,
    name,
    languages,
    // What and where to enter in PTV's UI, by kind (PROPOSAL_KINDS).
    steps: sheet.steps({
      target,
      name,
      ptvId: input.ptvId,
      organizationId: input.organizationId,
      channelId: input.channelId,
      languageList: languages.join(', ') || '(ei kieliversioita)',
    }),
    fields,
  };
}

function sheetField(entry: ServiceDiffEntry, isChannel: boolean): ManualPublishField | null {
  const [field = entry.field, language] = entry.field.split('.');
  if (STEP_FIELDS.has(field)) return null;
  const label =
    field === 'languages'
      ? isChannel
        ? 'Kielet, joilla asiointikanava palvelee'
        : 'Kielet, joilla palvelu on saatavilla'
      : (LABELS.get(field) ?? field);
  const before = entry.before === undefined ? undefined : formatValue(field, entry.before);
  return {
    field,
    label,
    ...(language ? { language } : {}),
    ...(before !== undefined ? { before } : {}),
    after: formatValue(field, entry.after),
  };
}

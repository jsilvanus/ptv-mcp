import type { LocalizedText } from '../ptv/domain.js';
import type { ProposalKind } from '../proposals/proposalService.js';
import { CHANNEL_TYPE_LABELS, EMPTY, formatValue, languageRank } from '../format/ptvFormat.js';
import { isCreateKind } from './proposalKinds.js';
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

/** What a sheet is about, by proposal kind; channels add their type. */
const TARGET_LABELS: Record<ProposalKind, string> = {
  service_update: 'Palvelu',
  service_create: 'Palvelu',
  channel_update: 'Asiointikanava',
  channel_create: 'Asiointikanava',
  connection_update: 'Liitoksen lisätiedot',
  organisation_update: 'Organisaatio',
  organisation_create: 'Alaorganisaatio',
};

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
  const creating = isCreateKind(input.kind);
  const isChannel = input.kind === 'channel_update' || input.kind === 'channel_create';
  const isConnection = input.kind === 'connection_update';
  const target = isChannel
    ? `Asiointikanava: ${CHANNEL_TYPE_LABELS[input.channelType ?? ''] ?? input.channelType ?? ''}`
    : TARGET_LABELS[input.kind];
  const name = input.names.fi ?? Object.values(input.names).find(Boolean) ?? null;
  const fields = input.diff
    .map((entry) => sheetField(entry, isChannel))
    .filter((field): field is ManualPublishField => field !== null)
    .sort(
      (a, b) =>
        (FIELD_ORDER.get(a.field) ?? 99) - (FIELD_ORDER.get(b.field) ?? 99) ||
        languageRank(a.language) - languageRank(b.language),
    );
  const languages = [...input.languages].sort((a, b) => languageRank(a) - languageRank(b));
  const languageList = languages.join(', ') || '(ei kieliversioita)';

  const steps = isConnection
    ? [
        `In PTV (palvelutietovaranto.suomi.fi), open the service "${name ?? input.ptvId}" (id ${input.ptvId}) and its Liitokset (connections) tab.`,
        `Open the connection to channel ${input.channelId ?? ''} and edit its additional information (lisätiedot).`,
        `Change the fields below. Copy each new value as it is; ${EMPTY} means clear the field. Save the connection.`,
        'When the change shows in PTV, confirm it here (ptv_confirm_manual_publish, or Mark as published in the Proposal queue). The MCP compares PTV with the proposal and closes it.',
      ]
    : creating
      ? [
          input.kind === 'organisation_create'
            ? `In PTV (palvelutietovaranto.suomi.fi), choose Lisää → Organisaatio and add the sub-organisation under organisation ${input.organizationId ?? ''} (only a PTV main user, pääkäyttäjä, can do this).`
            : `In PTV (palvelutietovaranto.suomi.fi), add a new ${target.toLowerCase()}${input.organizationId ? ` for organisation ${input.organizationId}` : ''}.`,
          'Fill in the fields below, in every language version listed. Copy each value as it is.',
          `Save it and publish the language versions ${languageList}, or leave it a draft if the Julkaisutila row says Luonnos.`,
          "Copy the new item's id from PTV and confirm here (ptv_confirm_manual_publish with ptvId, or Mark as published in the Proposal queue). The MCP checks the item in PTV and closes the proposal.",
        ]
      : [
          `In PTV (palvelutietovaranto.suomi.fi), open the ${target.toLowerCase()} "${name ?? input.ptvId}" (id ${input.ptvId}) and choose Muokkaa.`,
          `Change the fields below. Copy each new value as it is; ${EMPTY} means clear the field.`,
          `Publish every language version: ${languageList}. Publishing only some sends the others back to draft.`,
          'When the change shows in PTV, confirm it here (ptv_confirm_manual_publish, or Mark as published in the Proposal queue). The MCP compares PTV with the proposal and closes it.',
        ];

  return {
    action: creating ? 'create' : 'update',
    target,
    ptvId: input.ptvId,
    name,
    languages,
    steps,
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

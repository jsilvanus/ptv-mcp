import type {
  ChannelAddress,
  CodeListEntry,
  FormFile,
  LanguageValue,
  LocalizedText,
  PhoneNumber,
  ServiceHour,
  WebLink,
  Weekday,
} from '../ptv/domain.js';
import { expandOpeningTimes, WEEKDAYS } from '../ptv/serviceHours.js';
import type { ProposalKind } from '../proposals/proposalService.js';
import type { ServiceDiffEntry } from './proposeChanges.js';

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

const EMPTY = '(tyhjä)';

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  EChannel: 'Verkkoasiointi',
  WebPage: 'Verkkosivu',
  PrintableForm: 'Tulostettava lomake',
  Phone: 'Puhelinasiointi',
  ServiceLocation: 'Palvelupaikka',
};

/** PTV UI labels in the order the edit form shows them. */
const FIELD_LABELS: [field: string, label: string][] = [
  ['publishingStatus', 'Julkaisutila'],
  ['serviceType', 'Palvelun tyyppi'],
  ['generalDescriptionId', 'Pohjakuvaus'],
  ['names', 'Nimi'],
  ['summaries', 'Tiivistelmä'],
  ['descriptions', 'Kuvaus'],
  ['languages', 'Kielet'],
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
const LANGUAGE_ORDER = ['fi', 'sv', 'en', 'se', 'smn', 'sms'];
/** Stated in the steps instead of as fields. */
const STEP_FIELDS = new Set(['channelType', 'organizationId', 'id']);

const DAY_LABELS: Record<Weekday, string> = {
  Monday: 'ma',
  Tuesday: 'ti',
  Wednesday: 'ke',
  Thursday: 'to',
  Friday: 'pe',
  Saturday: 'la',
  Sunday: 'su',
};

export function buildManualPublishSheet(input: {
  kind: ProposalKind;
  diff: ServiceDiffEntry[];
  ptvId: string | null;
  names: LocalizedText;
  languages: string[];
  channelType?: string;
  organizationId?: string;
}): ManualPublishSheet {
  const creating = input.kind === 'service_create' || input.kind === 'channel_create';
  const isChannel = input.kind === 'channel_update' || input.kind === 'channel_create';
  const target = isChannel
    ? `Asiointikanava: ${CHANNEL_TYPE_LABELS[input.channelType ?? ''] ?? input.channelType ?? ''}`
    : 'Palvelu';
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

  const steps = creating
    ? [
        `In PTV (palvelutietovaranto.suomi.fi), add a new ${target.toLowerCase()}${input.organizationId ? ` for organisation ${input.organizationId}` : ''}.`,
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

function languageRank(language: string | undefined): number {
  if (!language) return -1;
  const index = LANGUAGE_ORDER.indexOf(language);
  return index === -1 ? LANGUAGE_ORDER.length : index;
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

/** A field value as PTV's UI shows it, one entry per line. */
export function formatValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return EMPTY;
  if (Array.isArray(value) && value.length === 0) return EMPTY;
  switch (field) {
    case 'publishingStatus':
      return PUBLISHING_STATUS_LABELS[value as string] ?? String(value);
    case 'accessibility':
      return ACCESSIBILITY_LABELS[value as string] ?? String(value);
    case 'serviceHours':
      return (value as ServiceHour[]).map(formatServiceHour).join('\n');
    case 'phoneNumbers':
    case 'supportPhones':
      return (value as PhoneNumber[]).map(formatPhone).join('\n');
    case 'addresses':
    case 'deliveryAddresses':
      return (value as ChannelAddress[]).map(formatAddress).join('\n');
    case 'emails':
    case 'supportEmails':
      return (value as LanguageValue[]).map((v) => `${v.language}: ${v.value}`).join('\n');
    case 'webPages':
      return (value as WebLink[])
        .map((link) => `${link.language}: ${link.name ? `${link.name} – ` : ''}${link.url}`)
        .join('\n');
    case 'formFiles':
      return (value as FormFile[]).map((f) => `${f.language}: ${f.format} ${f.url}`).join('\n');
    case 'serviceClasses':
    case 'ontologyTerms':
    case 'targetGroups':
    case 'lifeEvents':
    case 'industrialClasses':
      return (value as CodeListEntry[]).map(formatCode).join('\n');
  }
  if (typeof value === 'boolean') return value ? 'Kyllä' : 'Ei';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
  if (isLocalizedText(value)) return formatLocalized(value);
  return JSON.stringify(value, null, 2);
}

const PUBLISHING_STATUS_LABELS: Record<string, string> = {
  Published: 'Julkaistu',
  Draft: 'Luonnos',
  Archived: 'Arkistoitu',
  Modified: 'Muokattu',
};

const ACCESSIBILITY_LABELS: Record<string, string> = {
  FullyCompliant: 'Täyttää kriittiset saavutettavuusvaatimukset',
  PartiallyCompliant: 'Täyttää osittain kriittiset saavutettavuusvaatimukset',
  NonCompliant: 'Ei täytä kriittisiä saavutettavuusvaatimuksia',
  Unknown: 'Ei tietoa',
};

const CHARGE_LABELS: Record<string, string> = {
  Chargeable: 'Maksullinen (pvm/mpm)',
  FreeOfCharge: 'Maksuton',
  Other: 'Muu maksullisuus',
};

function isLocalizedText(value: unknown): value is LocalizedText {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === undefined || typeof v === 'string')
  );
}

function formatLocalized(text: LocalizedText | undefined): string {
  return Object.entries(text ?? {})
    .filter(([, v]) => !!v)
    .sort(([a], [b]) => languageRank(a) - languageRank(b))
    .map(([language, v]) => `${language}: ${v}`)
    .join('; ');
}

function formatCode(entry: CodeListEntry): string {
  const name = entry.names?.fi ?? Object.values(entry.names ?? {}).find(Boolean);
  const code = entry.code ?? entry.uri;
  return name ? `${name}${code ? ` (${code})` : ''}` : (code ?? '');
}

function formatPhone(phone: PhoneNumber): string {
  const number = phone.isFinnishServiceNumber
    ? phone.number
    : `${phone.prefixNumber ?? '+358'} ${phone.number}`;
  const type = phone.type === 'Sms' ? ' (tekstiviesti)' : phone.type === 'Fax' ? ' (faksi)' : '';
  const charge = phone.chargeType ? `; ${CHARGE_LABELS[phone.chargeType] ?? phone.chargeType}` : '';
  const chargeDescription = phone.chargeDescription ? `: ${phone.chargeDescription}` : '';
  const info = phone.additionalInformation ? ` – ${phone.additionalInformation}` : '';
  return `${phone.language}: ${number}${type}${info}${charge}${chargeDescription}`;
}

/** 2026-12-24 → 24.12.2026 */
function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${Number(day)}.${Number(month)}.${year}` : date;
}

/** 09:00 → 9.00 (PTV's UI format). */
function formatTime(time: string): string {
  const [hours = '', minutes = '00'] = time.split(':');
  return `${Number(hours)}.${minutes}`;
}

function formatServiceHour(hour: ServiceHour): string {
  const kind =
    hour.type === 'Exceptional'
      ? 'Poikkeava palveluaika'
      : hour.type === 'OverMidnight'
        ? 'Palveluaika yli vuorokauden vaihteen'
        : 'Normaali palveluaika';
  const period = hour.validFrom
    ? hour.validTo && hour.validTo !== hour.validFrom
      ? `${formatDate(hour.validFrom)}–${formatDate(hour.validTo)}`
      : formatDate(hour.validFrom)
    : hour.type === 'Exceptional'
      ? ''
      : 'toistaiseksi voimassa';
  const title = formatLocalized(hour.additionalInformation);
  let times: string;
  if (hour.isClosed) times = 'suljettu';
  else if (hour.isAlwaysOpen) times = 'aina avoinna';
  else if (hour.isReservation) times = 'ajanvarauksella';
  else if (hour.type === 'OverMidnight') {
    times = (hour.openingTimes ?? [])
      .map(
        (t) =>
          `${DAY_LABELS[t.dayFrom]} ${formatTime(t.from)} – ${DAY_LABELS[t.dayTo ?? t.dayFrom]} ${formatTime(t.to)}`,
      )
      .join(', ');
  } else times = groupDays(hour);
  return [kind, period, title && `otsikko ${title}`, times].filter(Boolean).join(', ');
}

/** Consecutive days with the same times as one range: "ma–pe 9.00–15.00". */
function groupDays(hour: ServiceHour): string {
  const sorted = expandOpeningTimes(hour).sort(
    (a, b) =>
      WEEKDAYS.indexOf(a.dayFrom) - WEEKDAYS.indexOf(b.dayFrom) || a.from.localeCompare(b.from),
  );
  const groups: { first: Weekday; last: Weekday; from: string; to: string }[] = [];
  for (const time of sorted) {
    const previous = groups.at(-1);
    if (
      previous &&
      previous.from === time.from &&
      previous.to === time.to &&
      WEEKDAYS.indexOf(time.dayFrom) === WEEKDAYS.indexOf(previous.last) + 1
    ) {
      previous.last = time.dayFrom;
    } else {
      groups.push({ first: time.dayFrom, last: time.dayFrom, from: time.from, to: time.to });
    }
  }
  return groups
    .map(
      (g) =>
        `${DAY_LABELS[g.first]}${g.last !== g.first ? `–${DAY_LABELS[g.last]}` : ''} ${formatTime(g.from)}–${formatTime(g.to)}`,
    )
    .join(', ');
}

function formatAddress(address: ChannelAddress): string {
  const purpose =
    address.purpose === 'Postal'
      ? 'Postiosoite'
      : address.receiver
        ? 'Toimitusosoite'
        : 'Käyntiosoite';
  const info = address.additionalInformation?.fi
    ? ` (${address.additionalInformation.fi})`
    : address.additionalInformation
      ? ` (${formatLocalized(address.additionalInformation)})`
      : '';
  const receiver = address.receiver ? `${formatLocalized(address.receiver)}, ` : '';
  switch (address.kind) {
    case 'Street': {
      const street = address.street?.fi ?? Object.values(address.street ?? {}).find(Boolean) ?? '';
      const line = [street, address.streetNumber].filter(Boolean).join(' ');
      return `${purpose}: ${receiver}${line}, ${address.postalCode ?? ''}${info}`;
    }
    case 'PostOfficeBox':
      return `${purpose}: ${receiver}${formatLocalized(address.postOfficeBox)}, ${address.postalCode ?? ''}${info}`;
    case 'Other':
      return `Muu sijaintitieto: ${address.latitude ?? '?'}, ${address.longitude ?? '?'}${info}`;
    case 'Foreign':
      return `Ulkomainen osoite: ${formatLocalized(address.text)}`;
    case 'NoAddress':
      return `Ei osoitetta: ${formatLocalized(address.text)}`;
  }
}

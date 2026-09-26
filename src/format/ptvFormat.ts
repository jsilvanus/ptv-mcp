import type {
  ChannelAddress,
  CodeListEntry,
  FormFile,
  LanguageValue,
  LocalizedText,
  OrganizationArea,
  PhoneNumber,
  ServiceHour,
  WebLink,
  Weekday,
} from '../ptv/domain.js';
import { expandOpeningTimes, WEEKDAYS } from '../ptv/serviceHours.js';

/**
 * PTV values as PTV's own UI shows them, in Finnish: labels for statuses,
 * types and charges, times 9.00, dates 24.12.2026, one list entry per line.
 * Shared by the manual-publishing sheet (src/mcp/manualPublish.ts) and the
 * content report (src/export/contentExport.ts).
 */

export const EMPTY = '(tyhjä)';

export const CHANNEL_TYPE_LABELS: Record<string, string> = {
  EChannel: 'Verkkoasiointi',
  WebPage: 'Verkkosivu',
  PrintableForm: 'Tulostettava lomake',
  Phone: 'Puhelinasiointi',
  ServiceLocation: 'Palvelupaikka',
};

export const LANGUAGE_ORDER = ['fi', 'sv', 'en', 'se', 'smn', 'sms'];
const DAY_LABELS: Record<Weekday, string> = {
  Monday: 'ma',
  Tuesday: 'ti',
  Wednesday: 'ke',
  Thursday: 'to',
  Friday: 'pe',
  Saturday: 'la',
  Sunday: 'su',
};

/** Sort key for languages: fi, sv, en, the Sámi languages, then the rest. */
/** An item's name for lists and reports: Finnish, else Swedish, English or any language. */
export function displayName(names: LocalizedText | undefined): string | undefined {
  return names?.fi ?? names?.sv ?? names?.en ?? Object.values(names ?? {}).find(Boolean);
}

export function languageRank(language: string | undefined): number {
  if (!language) return -1;
  const index = LANGUAGE_ORDER.indexOf(language);
  return index === -1 ? LANGUAGE_ORDER.length : index;
}

/** A field value as PTV's UI shows it, one entry per line. */
export function formatValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return EMPTY;
  if (Array.isArray(value) && value.length === 0) return EMPTY;
  switch (field) {
    case 'publishingStatus':
      return PUBLISHING_STATUS_LABELS[value as string] ?? String(value);
    case 'serviceType':
      return SERVICE_TYPE_LABELS[value as string] ?? String(value);
    case 'chargeType':
      return CONNECTION_CHARGE_LABELS[value as string] ?? String(value);
    case 'organizationType':
      return ORGANIZATION_TYPE_LABELS[value as string] ?? String(value);
    case 'area':
      return formatArea(value as OrganizationArea);
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

export const PUBLISHING_STATUS_LABELS: Record<string, string> = {
  Published: 'Julkaistu',
  Draft: 'Luonnos',
  Archived: 'Arkistoitu',
  Modified: 'Muokattu',
  Withdrawn: 'Poistettu',
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  Service: 'Palvelu',
  PermitOrObligation: 'Lupa tai velvoite',
  ProfessionalQualification: 'Ammattipätevyys',
};

const ACCESSIBILITY_LABELS: Record<string, string> = {
  FullyCompliant: 'Täyttää kriittiset saavutettavuusvaatimukset',
  PartiallyCompliant: 'Täyttää osittain kriittiset saavutettavuusvaatimukset',
  NonCompliant: 'Ei täytä kriittisiä saavutettavuusvaatimuksia',
  Unknown: 'Ei tietoa',
};

const ORGANIZATION_TYPE_LABELS: Record<string, string> = {
  State: 'Valtio',
  Region: 'Maakunta',
  RegionalOrganization: 'Alueellinen yhteistoimintaorganisaatio',
  Municipality: 'Kunta',
  Organization: 'Järjestöt ja yhteisöt',
  Company: 'Yritykset',
};

function formatArea(area: OrganizationArea): string {
  if (area.areaType === 'Nationwide') return 'Koko maa';
  if (area.areaType === 'NationwideExceptAlandIslands') return 'Koko maa paitsi Ahvenanmaa';
  return `Rajattu alue: ${(area.areas ?? []).map((a) => `${a.type} ${a.code}`).join(', ')}`;
}

const CONNECTION_CHARGE_LABELS: Record<string, string> = {
  Chargeable: 'Maksullinen',
  FreeOfCharge: 'Maksuton',
  Other: 'Muu',
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

export function formatLocalized(text: LocalizedText | undefined): string {
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

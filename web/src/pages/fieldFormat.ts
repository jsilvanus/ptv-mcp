import type { PreviewAddress, PreviewPhone, PreviewServiceHour } from '../api/types';

/**
 * Human-readable text for a proposal's field values, shared by the diff
 * table (DiffView) and the channel preview (ChannelDetails), so structured
 * channel fields (phones, hours, addresses…) never show as raw JSON.
 */

const WEEKDAY_ORDER = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const WEEKDAYS: Record<string, string> = {
  Monday: 'ma',
  Tuesday: 'ti',
  Wednesday: 'ke',
  Thursday: 'to',
  Friday: 'pe',
  Saturday: 'la',
  Sunday: 'su',
};

const CHARGES: Record<string, string> = {
  Chargeable: 'normaali puhelumaksu',
  FreeOfCharge: 'maksuton',
  Other: 'lisämaksullinen',
};

export const ACCESSIBILITY: Record<string, string> = {
  FullyCompliant: 'Saavutettavuus on huomioitu hyvin',
  PartiallyCompliant: 'Saavutettavuus on huomioitu osittain',
  NonCompliant: 'Saavutettavuutta ei ole huomioitu',
  Unknown: 'Ei tietoa',
};

const PUBLISHING_STATUS: Record<string, string> = {
  Published: 'Julkaistu',
  Draft: 'Luonnos',
  Archived: 'Arkistoitu',
  Modified: 'Muokattu',
};

const HOUR_TYPES: Record<string, string> = {
  DaysOfTheWeek: 'Normaali palveluaika',
  Exceptional: 'Poikkeava palveluaika',
  OverMidnight: 'Yli vuorokauden vaihteen',
};

type Text = Record<string, string> | undefined;

function pick(text: Text, language: string): string | undefined {
  const value = text?.[language] ?? Object.values(text ?? {})[0];
  return typeof value === 'string' ? value : undefined;
}

export function formatPhone(p: PreviewPhone): string {
  const number = p.isFinnishServiceNumber ? p.number : `${p.prefixNumber ?? '+358'} ${p.number}`;
  const type =
    p.type && p.type !== 'Phone' ? ` (${p.type === 'Sms' ? 'tekstiviesti' : 'faksi'})` : '';
  const info = p.additionalInformation ? ` – ${p.additionalInformation}` : '';
  const charge = p.chargeType ? `, ${CHARGES[p.chargeType] ?? p.chargeType}` : '';
  const chargeText = p.chargeDescription ? ` (${p.chargeDescription})` : '';
  return `${number}${type}${info}${charge}${chargeText}`;
}

export function formatAddress(a: PreviewAddress, language: string): string {
  const extra = pick(a.additionalInformation, language);
  let main: string;
  if (a.kind === 'Street') {
    main =
      `${pick(a.street, language) ?? ''} ${a.streetNumber ?? ''}, ${a.postalCode ?? ''}`.trim();
  } else if (a.kind === 'PostOfficeBox') {
    main = `${pick(a.postOfficeBox, language) ?? ''}, ${a.postalCode ?? ''}`;
  } else if (a.kind === 'Other') {
    main = `${a.latitude ?? '?'}, ${a.longitude ?? '?'} (ei katuosoitetta)`;
  } else {
    main = pick(a.text, language) ?? '';
  }
  const receiver = pick(a.receiver, language);
  return [
    a.purpose === 'Postal' ? 'Postiosoite: ' : '',
    receiver ? `${receiver}, ` : '',
    main,
    extra ? ` – ${extra}` : '',
  ].join('');
}

/** Opening times with consecutive days of the same times as one range: "ma–pe 09:00–15:00". */
function formatOpeningTimes(h: PreviewServiceHour): string {
  const times = h.openingTimes ?? [];
  if (h.type === 'OverMidnight') {
    return times
      .map(
        (t) =>
          `${WEEKDAYS[t.dayFrom] ?? t.dayFrom} ${t.from} – ${WEEKDAYS[t.dayTo ?? t.dayFrom] ?? t.dayTo} ${t.to}`,
      )
      .join(', ');
  }
  // Ranges (dayFrom–dayTo) and single days both become one entry per day first.
  const days = times.flatMap((t) => {
    const start = WEEKDAY_ORDER.indexOf(t.dayFrom);
    const end = t.dayTo ? WEEKDAY_ORDER.indexOf(t.dayTo) : start;
    if (start < 0 || end < 0) return [{ day: start, label: t.dayFrom, from: t.from, to: t.to }];
    const span = end >= start ? end - start : end + 7 - start;
    return Array.from({ length: span + 1 }, (_, i) => {
      const day = (start + i) % 7;
      return { day, label: WEEKDAY_ORDER[day]!, from: t.from, to: t.to };
    });
  });
  days.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
  const groups: { first: string; last: string; lastDay: number; from: string; to: string }[] = [];
  for (const d of days) {
    const previous = groups.at(-1);
    if (
      previous &&
      previous.from === d.from &&
      previous.to === d.to &&
      d.day === previous.lastDay + 1
    ) {
      previous.last = d.label;
      previous.lastDay = d.day;
    } else {
      groups.push({ first: d.label, last: d.label, lastDay: d.day, from: d.from, to: d.to });
    }
  }
  return groups
    .map(
      (g) =>
        `${WEEKDAYS[g.first] ?? g.first}${g.last !== g.first ? `–${WEEKDAYS[g.last] ?? g.last}` : ''} ${g.from}–${g.to}`,
    )
    .join(', ');
}

export function formatServiceHour(h: PreviewServiceHour, language: string): string {
  const title = pick(h.additionalInformation, language);
  const range =
    h.validFrom || h.validTo
      ? ` ${h.validFrom ?? ''}${h.validTo && h.validTo !== h.validFrom ? `–${h.validTo}` : ''}`
      : '';
  const times = h.isAlwaysOpen
    ? 'aina avoinna'
    : h.isReservation
      ? 'ajanvarauksella'
      : h.isClosed
        ? 'suljettu'
        : formatOpeningTimes(h);
  const kind = h.type === 'DaysOfTheWeek' ? '' : `${HOUR_TYPES[h.type] ?? h.type}: `;
  return `${kind}${title ? `${title}: ` : ''}${times}${range}`;
}

const lines = (values: string[]) => values.join('\n');

/**
 * A field's value as text, by the field's name (`phoneNumbers`, or a
 * localized `names.fi`). Lists get one line per entry, with the language
 * where entries are per language.
 */
const CHARGE_TYPE: Record<string, string> = {
  Chargeable: 'Maksullinen',
  FreeOfCharge: 'Maksuton',
  Other: 'Muu',
};

export function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined) return '(ei arvoa)';
  if (value === null || value === '') return '(tyhjä)';
  const base = field.split('.')[0] ?? field;
  const list = Array.isArray(value) ? (value as unknown[]) : null;
  if (list && list.length === 0) return '(tyhjä)';
  try {
    switch (base) {
      case 'phoneNumbers':
      case 'supportPhones':
        return lines((list as PreviewPhone[]).map((p) => `${p.language}: ${formatPhone(p)}`));
      case 'serviceHours':
        return lines((list as PreviewServiceHour[]).map((h) => formatServiceHour(h, 'fi')));
      case 'addresses':
      case 'deliveryAddresses':
        return lines((list as PreviewAddress[]).map((a) => formatAddress(a, 'fi')));
      case 'emails':
      case 'supportEmails':
        return lines(
          (list as { language: string; value: string }[]).map((e) => `${e.language}: ${e.value}`),
        );
      case 'webPages':
        return lines(
          (list as { language: string; url: string; name?: string }[]).map(
            (p) => `${p.language}: ${p.name ? `${p.name} – ` : ''}${p.url}`,
          ),
        );
      case 'formFiles':
        return lines(
          (list as { language: string; format: string; url: string }[]).map(
            (f) => `${f.language}: ${f.format} ${f.url}`,
          ),
        );
      case 'accessibility':
        return ACCESSIBILITY[value as string] ?? String(value);
      case 'publishingStatus':
        return PUBLISHING_STATUS[value as string] ?? String(value);
      case 'chargeType':
        return CHARGE_TYPE[value as string] ?? String(value);
    }
  } catch {
    // Unexpected shape: fall back to the generic text below.
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'kyllä' : 'ei';
  if (list && list.every((item) => typeof item === 'string')) return list.join(', ');
  if (
    typeof value === 'object' &&
    !list &&
    Object.values(value as object).every((v) => typeof v === 'string')
  ) {
    // Language-keyed text such as urls or formIdentifiers.
    return lines(Object.entries(value as Record<string, string>).map(([k, v]) => `${k}: ${v}`));
  }
  return JSON.stringify(value, null, 2);
}

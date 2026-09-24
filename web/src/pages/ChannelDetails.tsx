import type { PreviewAddress, PreviewEntity, PreviewPhone, PreviewServiceHour } from '../api/types';
import { FIELD_LABELS } from './ptvLabels';

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

const ACCESSIBILITY: Record<string, string> = {
  FullyCompliant: 'Saavutettavuus on huomioitu hyvin',
  PartiallyCompliant: 'Saavutettavuus on huomioitu osittain',
  NonCompliant: 'Saavutettavuutta ei ole huomioitu',
  Unknown: 'Ei tietoa',
};

function phone(p: PreviewPhone): string {
  const number = p.isFinnishServiceNumber ? p.number : `${p.prefixNumber ?? '+358'} ${p.number}`;
  const type =
    p.type && p.type !== 'Phone' ? ` (${p.type === 'Sms' ? 'tekstiviesti' : 'faksi'})` : '';
  const info = p.additionalInformation ? ` – ${p.additionalInformation}` : '';
  const charge = p.chargeType ? `, ${CHARGES[p.chargeType] ?? p.chargeType}` : '';
  const chargeText = p.chargeDescription ? ` (${p.chargeDescription})` : '';
  return `${number}${type}${info}${charge}${chargeText}`;
}

function address(a: PreviewAddress, language: string): string {
  const pick = (text?: Record<string, string>) => text?.[language] ?? Object.values(text ?? {})[0];
  const extra = pick(a.additionalInformation);
  let main: string;
  if (a.kind === 'Street') {
    main = `${pick(a.street) ?? ''} ${a.streetNumber ?? ''}, ${a.postalCode ?? ''}`.trim();
  } else if (a.kind === 'PostOfficeBox') {
    main = `${pick(a.postOfficeBox) ?? ''}, ${a.postalCode ?? ''}`;
  } else if (a.kind === 'Other') {
    main = `${a.latitude ?? '?'}, ${a.longitude ?? '?'} (ei katuosoitetta)`;
  } else {
    main = pick(a.text) ?? '';
  }
  const receiver = pick(a.receiver);
  return [
    a.purpose === 'Postal' ? 'Postiosoite: ' : '',
    receiver ? `${receiver}, ` : '',
    main,
    extra ? ` – ${extra}` : '',
  ].join('');
}

function hour(h: PreviewServiceHour, language: string): string {
  const title =
    h.additionalInformation?.[language] ?? Object.values(h.additionalInformation ?? {})[0];
  const range = h.validFrom || h.validTo ? ` ${h.validFrom ?? ''}–${h.validTo ?? ''}` : '';
  const times = h.isAlwaysOpen
    ? 'aina avoinna'
    : h.isReservation
      ? 'ajanvarauksella'
      : h.isClosed
        ? 'suljettu'
        : (h.openingTimes ?? [])
            .map(
              (t) =>
                `${WEEKDAYS[t.dayFrom] ?? t.dayFrom}${t.dayTo ? `–${WEEKDAYS[t.dayTo] ?? t.dayTo}` : ''} ${t.from}–${t.to}`,
            )
            .join(', ');
  return `${title ? `${title}: ` : ''}${times}${range}`;
}

/** The structured fields of a service channel, one language at a time. */
export function ChannelDetails({ entity, language }: { entity: PreviewEntity; language: string }) {
  const rows: [string, string[]][] = [];
  const add = (field: string, values: (string | undefined)[]) => {
    const present = values.filter((v): v is string => !!v);
    if (present.length > 0) rows.push([FIELD_LABELS[field] ?? field, present]);
  };
  const forLanguage = <T extends { language: string }>(items?: T[]) =>
    (items ?? []).filter((item) => item.language === language);

  add('channelType', [entity.channelType]);
  add('urls', [entity.urls?.[language]]);
  add('phoneNumbers', forLanguage(entity.phoneNumbers).map(phone));
  add(
    'emails',
    forLanguage(entity.emails).map((e) => e.value),
  );
  add(
    'addresses',
    (entity.addresses ?? []).map((a) => address(a, language)),
  );
  add(
    'serviceHours',
    (entity.serviceHours ?? []).map((h) => hour(h, language)),
  );
  add(
    'webPages',
    forLanguage(entity.webPages).map((p) => (p.name ? `${p.name}: ${p.url}` : p.url)),
  );
  add('formIdentifiers', [entity.formIdentifiers?.[language]]);
  add(
    'formFiles',
    forLanguage(entity.formFiles).map((f) => `${f.format}: ${f.url}`),
  );
  add(
    'deliveryAddresses',
    (entity.deliveryAddresses ?? []).map((a) => address(a, language)),
  );
  add('supportPhones', forLanguage(entity.supportPhones).map(phone));
  add(
    'supportEmails',
    forLanguage(entity.supportEmails).map((e) => e.value),
  );
  if (entity.channelType === 'EChannel') {
    add('requiresAuthentication', [entity.requiresAuthentication ? 'kyllä' : 'ei']);
    add('requiresSignature', [
      entity.requiresSignature ? `kyllä (${entity.signatureQuantity ?? 1})` : 'ei',
    ]);
  }
  add('accessibility', [entity.accessibility ? ACCESSIBILITY[entity.accessibility] : undefined]);
  if (entity.isVisibleForAll !== undefined) {
    add('isVisibleForAll', [
      entity.isVisibleForAll ? 'muut organisaatiot voivat liittää' : 'vain oma organisaatio',
    ]);
  }

  if (rows.length === 0) return null;
  return (
    <table>
      <tbody>
        {rows.map(([label, values]) => (
          <tr key={label}>
            <th style={{ textAlign: 'left', verticalAlign: 'top' }}>{label}</th>
            <td>
              {values.map((value) => (
                <div key={value}>{value}</div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

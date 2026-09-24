import type { PreviewEntity } from '../api/types';
import { ACCESSIBILITY, formatAddress, formatPhone, formatServiceHour } from './fieldFormat';
import { FIELD_LABELS } from './ptvLabels';

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
  add('phoneNumbers', forLanguage(entity.phoneNumbers).map(formatPhone));
  add(
    'emails',
    forLanguage(entity.emails).map((e) => e.value),
  );
  add(
    'addresses',
    (entity.addresses ?? []).map((a) => formatAddress(a, language)),
  );
  add(
    'serviceHours',
    (entity.serviceHours ?? []).map((h) => formatServiceHour(h, language)),
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
    (entity.deliveryAddresses ?? []).map((a) => formatAddress(a, language)),
  );
  add('supportPhones', forLanguage(entity.supportPhones).map(formatPhone));
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

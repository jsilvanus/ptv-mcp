import { describe, expect, it } from 'vitest';
import { buildManualPublishSheet, formatValue } from './manualPublish.js';

describe('buildManualPublishSheet', () => {
  it('lists an update in PTV form order with Finnish labels and PTV formats', () => {
    const sheet = buildManualPublishSheet({
      kind: 'channel_update',
      ptvId: 'channel-1',
      names: { fi: 'Testimonitoimitalo' },
      languages: ['sv', 'fi'],
      channelType: 'ServiceLocation',
      diff: [
        {
          field: 'serviceHours',
          before: undefined,
          after: [
            {
              type: 'DaysOfTheWeek',
              openingTimes: [
                { dayFrom: 'Monday', dayTo: 'Friday', from: '09:00', to: '20:00' },
                { dayFrom: 'Saturday', dayTo: 'Sunday', from: '09:00', to: '22:00' },
              ],
            },
            {
              type: 'Exceptional',
              validFrom: '2026-12-24',
              validTo: '2026-12-26',
              isClosed: true,
              additionalInformation: { fi: 'Joulu' },
            },
          ],
        },
        { field: 'summaries.sv', before: 'Gammal', after: 'Ny' },
        {
          field: 'phoneNumbers',
          before: undefined,
          after: [
            {
              language: 'fi',
              prefixNumber: '+358',
              number: '401234567',
              additionalInformation: 'Vaihde',
              chargeType: 'Chargeable',
            },
          ],
        },
        { field: 'summaries.fi', before: 'Vanha', after: 'Uusi' },
      ],
    });
    expect(sheet).toMatchObject({
      action: 'update',
      target: 'Asiointikanava: Palvelupaikka',
      ptvId: 'channel-1',
      name: 'Testimonitoimitalo',
      languages: ['fi', 'sv'],
    });
    expect(sheet.fields.map((f) => [f.label, f.language])).toEqual([
      ['Tiivistelmä', 'fi'],
      ['Tiivistelmä', 'sv'],
      ['Puhelinnumerot', undefined],
      ['Palveluajat', undefined],
    ]);
    expect(sheet.fields[2]!.after).toBe('fi: +358 401234567 – Vaihde; Maksullinen (pvm/mpm)');
    expect(sheet.fields[3]!.after).toBe(
      [
        'Normaali palveluaika, toistaiseksi voimassa, ma–pe 9.00–20.00, la–su 9.00–22.00',
        'Poikkeava palveluaika, 24.12.2026–26.12.2026, otsikko fi: Joulu, suljettu',
      ].join('\n'),
    );
    expect(sheet.steps.join(' ')).toContain('fi, sv');
  });

  it('describes a new channel without its type and organisation as fields', () => {
    const sheet = buildManualPublishSheet({
      kind: 'channel_create',
      ptvId: null,
      names: { fi: 'Neuvontapuhelin' },
      languages: ['fi'],
      channelType: 'Phone',
      organizationId: 'org-1',
      diff: [
        { field: 'publishingStatus', before: undefined, after: 'Draft' },
        { field: 'names.fi', before: undefined, after: 'Neuvontapuhelin' },
        { field: 'channelType', before: undefined, after: 'Phone' },
        { field: 'organizationId', before: undefined, after: 'org-1' },
      ],
    });
    expect(sheet.action).toBe('create');
    expect(sheet.fields).toEqual([
      { field: 'publishingStatus', label: 'Julkaisutila', after: 'Luonnos' },
      { field: 'names', label: 'Nimi', language: 'fi', after: 'Neuvontapuhelin' },
    ]);
    expect(sheet.steps[0]).toContain('asiointikanava: puhelinasiointi for organisation org-1');
    expect(sheet.steps.at(-1)).toContain('ptvId');
  });
});

describe('formatValue', () => {
  it('formats classes, empties and addresses', () => {
    expect(
      formatValue('serviceClasses', [{ code: 'P27.1', names: { fi: 'Liikunta ja urheilu' } }]),
    ).toBe('Liikunta ja urheilu (P27.1)');
    expect(formatValue('descriptions', '')).toBe('(tyhjä)');
    expect(
      formatValue('addresses', [
        {
          kind: 'Street',
          street: { fi: 'Aurakatu' },
          streetNumber: '2',
          postalCode: '20100',
          additionalInformation: { fi: 'Sisäänkäynti pihalta' },
        },
      ]),
    ).toBe('Käyntiosoite: Aurakatu 2, 20100 (Sisäänkäynti pihalta)');
  });
});

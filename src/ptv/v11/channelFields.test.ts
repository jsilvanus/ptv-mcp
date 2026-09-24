import { describe, expect, it } from 'vitest';
import type { ServiceChannel } from '../domain.js';
import { channelChangesToV11Body, newChannelToV11Body } from './channelWriteMapping.js';
import { serviceChannelWireToDomain } from './mappers/serviceChannel.js';
import type { V11ServiceChannelWire } from './wireModel.js';

function wire(overrides: Partial<V11ServiceChannelWire> = {}): V11ServiceChannelWire {
  return {
    id: 'ch-1',
    serviceChannelType: 'ServiceLocation',
    organizationId: 'org-15',
    publishingStatus: 'Published',
    serviceChannelNames: [{ language: 'fi', value: 'Seurakuntakeskus', type: 'Name' }],
    serviceChannelDescriptions: [
      { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
      { language: 'fi', value: 'Kuvaus', type: 'Description' },
    ],
    languages: ['fi', 'sv'],
    modified: '2026-09-24T00:00:00',
    ...overrides,
  };
}

describe('serviceChannelWireToDomain: channel fields', () => {
  it('reads a service location: summaries, addresses, phones, faxes, emails and hours', () => {
    const channel = serviceChannelWireToDomain(
      wire({
        isVisibleForAll: true,
        addresses: [
          {
            type: 'Location',
            subType: 'Street',
            streetAddress: {
              street: [{ language: 'fi', value: 'Kirkkokatu' }],
              streetNumber: '5',
              postalCode: '11100',
              municipality: { code: '694' },
              latitude: '6729000',
              longitude: '3378000',
              additionalInformation: [{ language: 'fi', value: 'Sisäänkäynti pihalta' }],
            },
          },
          {
            type: 'Postal',
            subType: 'PostOfficeBox',
            postOfficeBoxAddress: {
              postOfficeBox: [{ language: 'fi', value: 'PL 12' }],
              postalCode: '11101',
            },
          },
        ],
        phoneNumbers: [
          {
            language: 'fi',
            type: 'Phone',
            prefixNumber: '+358',
            number: '19 123 4567',
            additionalInformation: 'Vaihde',
            serviceChargeType: 'Chargeable',
          },
          { language: 'fi', type: 'Fax', prefixNumber: '+358', number: '19 765 4321' },
        ],
        supportEmails: [{ language: 'fi', value: 'kirkkoherranvirasto@example.fi' }],
        webPages: [{ language: 'fi', url: 'https://example.fi/kirkko', value: 'Kirkko' }],
        serviceHours: [
          {
            serviceHourType: 'DaysOfTheWeek',
            validForNow: true,
            openingHour: [{ dayFrom: 'Monday', dayTo: 'Friday', from: '09:00:00', to: '15:00:00' }],
          },
          {
            serviceHourType: 'Exceptional',
            validFrom: '2026-12-24T00:00:00',
            validTo: '2026-12-26T00:00:00',
            isClosed: true,
          },
        ],
      }),
    );
    expect(channel.summaries).toEqual({ fi: 'Tiivistelmä' });
    expect(channel.descriptions).toEqual({ fi: 'Kuvaus' });
    expect(channel.isVisibleForAll).toBe(true);
    expect(channel.addresses).toEqual([
      {
        kind: 'Street',
        purpose: 'Visiting',
        street: { fi: 'Kirkkokatu' },
        streetNumber: '5',
        postalCode: '11100',
        municipality: '694',
        latitude: '6729000',
        longitude: '3378000',
        additionalInformation: { fi: 'Sisäänkäynti pihalta' },
      },
      {
        kind: 'PostOfficeBox',
        purpose: 'Postal',
        postOfficeBox: { fi: 'PL 12' },
        postalCode: '11101',
      },
    ]);
    expect(channel.phoneNumbers).toEqual([
      {
        language: 'fi',
        type: 'Phone',
        prefixNumber: '+358',
        number: '19 123 4567',
        additionalInformation: 'Vaihde',
        chargeType: 'Chargeable',
      },
      { language: 'fi', type: 'Fax', prefixNumber: '+358', number: '19 765 4321' },
    ]);
    expect(channel.emails).toEqual([{ language: 'fi', value: 'kirkkoherranvirasto@example.fi' }]);
    expect(channel.webPages).toEqual([
      { language: 'fi', url: 'https://example.fi/kirkko', name: 'Kirkko' },
    ]);
    expect(channel.serviceHours).toEqual([
      {
        type: 'DaysOfTheWeek',
        validForNow: true,
        openingTimes: [{ dayFrom: 'Monday', dayTo: 'Friday', from: '09:00', to: '15:00' }],
      },
      { type: 'Exceptional', validFrom: '2026-12-24', validTo: '2026-12-26', isClosed: true },
    ]);
  });

  it("reads an e-service's web page as its url, plus authentication and accessibility", () => {
    const channel = serviceChannelWireToDomain(
      wire({
        serviceChannelType: 'EChannel',
        webPages: [
          { language: 'fi', url: 'https://example.fi/ilmo' },
          { language: 'sv', url: 'https://example.fi/sv/anmalan' },
        ],
        requiresAuthentication: true,
        requiresSignature: true,
        signatureQuantity: '2',
        supportEmails: [{ language: 'fi', value: 'tuki@example.fi' }],
        accessibilityClassification: [
          { language: 'fi', accessibilityClassificationLevel: 'PartiallyCompliant' },
        ],
      }),
    );
    expect(channel.urls).toEqual({
      fi: 'https://example.fi/ilmo',
      sv: 'https://example.fi/sv/anmalan',
    });
    expect(channel.webPages).toBeUndefined();
    expect(channel).toMatchObject({
      requiresAuthentication: true,
      requiresSignature: true,
      signatureQuantity: 2,
      accessibility: 'PartiallyCompliant',
      supportEmails: [{ language: 'fi', value: 'tuki@example.fi' }],
    });
  });

  it('reads a printable form: files, identifier and delivery address', () => {
    const channel = serviceChannelWireToDomain(
      wire({
        serviceChannelType: 'PrintableForm',
        channelUrls: [{ language: 'fi', value: 'https://example.fi/lomake.pdf', type: 'PDF' }],
        formIdentifier: [{ language: 'fi', value: 'RK 1' }],
        deliveryAddresses: [
          {
            subType: 'NoAddress',
            deliveryAddressInText: [{ language: 'fi', value: 'Palauta kerhon ohjaajalle.' }],
            receiver: [{ language: 'fi', value: 'Kerhotoiminta' }],
          },
        ],
      }),
    );
    expect(channel.formFiles).toEqual([
      { language: 'fi', format: 'PDF', url: 'https://example.fi/lomake.pdf' },
    ]);
    expect(channel.formIdentifiers).toEqual({ fi: 'RK 1' });
    expect(channel.deliveryAddresses).toEqual([
      {
        kind: 'NoAddress',
        text: { fi: 'Palauta kerhon ohjaajalle.' },
        receiver: { fi: 'Kerhotoiminta' },
      },
    ]);
  });
});

describe('channelChangesToV11Body: channel fields', () => {
  it('replaces the summaries and keeps the descriptions', () => {
    expect(channelChangesToV11Body({ summaries: { fi: 'Uusi' } }, wire())).toEqual({
      publishingStatus: 'Published',
      serviceChannelDescriptions: [
        { language: 'fi', value: 'Kuvaus', type: 'Description' },
        { language: 'fi', value: 'Uusi', type: 'Summary' },
      ],
    });
  });

  it('writes a service location’s phones and faxes to their own lists, and clears emptied ones', () => {
    const body = channelChangesToV11Body(
      {
        phoneNumbers: [
          {
            language: 'fi',
            prefixNumber: '+358',
            number: '19 123 4567',
            additionalInformation: 'Vaihde',
          },
          { language: 'fi', type: 'Fax', prefixNumber: '+358', number: '19 765 4321' },
        ],
        serviceHours: [],
        webPages: [],
      },
      wire(),
    );
    expect(body.phoneNumbers).toEqual([
      {
        language: 'fi',
        number: '19 123 4567',
        prefixNumber: '+358',
        additionalInformation: 'Vaihde',
        serviceChargeType: 'Chargeable',
      },
    ]);
    expect(body.faxNumbers).toEqual([
      { language: 'fi', number: '19 765 4321', prefixNumber: '+358' },
    ]);
    expect(body.deleteAllServiceHours).toBe(true);
    expect(body.deleteAllWebPages).toBe(true);
    expect(body.serviceHours).toBeUndefined();
  });

  it('writes addresses and service hours in the In shapes', () => {
    const body = channelChangesToV11Body(
      {
        addresses: [
          {
            kind: 'Street',
            street: { fi: 'Kirkkokatu' },
            streetNumber: '5',
            postalCode: '11100',
            municipality: '694',
          },
        ],
        serviceHours: [
          {
            type: 'DaysOfTheWeek',
            additionalInformation: { fi: 'Syyskausi' },
            openingTimes: [{ dayFrom: 'Monday', dayTo: 'Friday', from: '09:00', to: '15:00' }],
          },
        ],
      },
      wire(),
    );
    expect(body.addresses).toEqual([
      {
        type: 'Location',
        subType: 'Street',
        streetAddress: {
          street: [{ language: 'fi', value: 'Kirkkokatu' }],
          streetNumber: '5',
          postalCode: '11100',
        },
      },
    ]);
    expect(body.serviceHours).toEqual([
      {
        serviceHourType: 'DaysOfTheWeek',
        validForNow: true,
        isClosed: false,
        isAlwaysOpen: false,
        isReservation: false,
        additionalInformation: [{ language: 'fi', value: 'Syyskausi' }],
        // A weekday range is written out one day per entry (dayTo would mean over midnight).
        openingHour: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((dayFrom) => ({
          dayFrom,
          from: '09:00',
          to: '15:00',
        })),
      },
    ]);
  });

  it("writes an e-service's url as webPage and keeps requiresAuthentication", () => {
    const body = channelChangesToV11Body(
      { urls: { fi: 'https://example.fi/uusi' }, accessibility: 'Unknown' },
      wire({ serviceChannelType: 'EChannel', requiresAuthentication: true }),
    );
    expect(body.webPage).toEqual([{ language: 'fi', value: 'https://example.fi/uusi' }]);
    expect(body.requiresAuthentication).toBe(true);
    expect(body.accessibilityClassification).toEqual([
      { language: 'fi', accessibilityClassificationLevel: 'Unknown' },
    ]);
  });
});

describe('newChannelToV11Body', () => {
  const base: Omit<ServiceChannel, 'id' | 'channelType'> = {
    organizationId: 'org-15',
    publishingStatus: 'Draft',
    names: { fi: 'Ilmoittautuminen' },
    summaries: { fi: 'Ilmoittaudu rippikouluun verkossa.' },
    descriptions: { fi: 'Ilmoittaudu verkossa.' },
    languages: ['fi'],
  };

  it('builds an e-service with the fields PTV requires', () => {
    expect(
      newChannelToV11Body({
        ...base,
        channelType: 'EChannel',
        urls: { fi: 'https://example.fi/ilmo' },
        serviceIds: ['s-1'],
      }),
    ).toEqual({
      organizationId: 'org-15',
      publishingStatus: 'Draft',
      languages: ['fi'],
      serviceChannelNames: [{ language: 'fi', value: 'Ilmoittautuminen', type: 'Name' }],
      serviceChannelDescriptions: [
        { language: 'fi', value: 'Ilmoittaudu rippikouluun verkossa.', type: 'Summary' },
        { language: 'fi', value: 'Ilmoittaudu verkossa.', type: 'Description' },
      ],
      isVisibleForAll: true,
      services: ['s-1'],
      webPage: [{ language: 'fi', value: 'https://example.fi/ilmo' }],
      requiresAuthentication: false,
      accessibilityClassification: [
        { language: 'fi', accessibilityClassificationLevel: 'Unknown' },
      ],
    });
  });

  it('gives a service location its display name type and addresses', () => {
    const body = newChannelToV11Body({
      ...base,
      channelType: 'ServiceLocation',
      addresses: [{ kind: 'Street', street: { fi: 'Kirkkokatu' }, postalCode: '11100' }],
    });
    expect(body.displayNameType).toEqual([{ type: 'Name', language: 'fi' }]);
    expect(body.addresses).toHaveLength(1);
    expect(body.accessibilityClassification).toBeUndefined();
  });

  it('writes a phone channel’s typed numbers', () => {
    const body = newChannelToV11Body({
      ...base,
      channelType: 'Phone',
      phoneNumbers: [{ language: 'fi', type: 'Sms', prefixNumber: '+358', number: '40 123 4567' }],
    });
    expect(body.phoneNumbers).toEqual([
      {
        language: 'fi',
        number: '40 123 4567',
        prefixNumber: '+358',
        serviceChargeType: 'Chargeable',
        type: 'Sms',
      },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { connectionDetailsToDomain, connectionDetailsToWire } from './connectionDetails.js';

/** A connection's extra info as GET /api/v11/Service/{id} returns it in serviceChannels. */
const wire = {
  serviceChargeType: 'Other',
  description: [
    { language: 'fi', value: 'Diakoniatyön vastaanotto', type: 'Description' },
    { language: 'fi', value: 'Materiaalimaksu', type: 'ChargeTypeAdditionalInfo' },
    { language: 'sv', value: null, type: 'Description' },
  ],
  serviceHours: [
    {
      serviceHourType: 'DaysOfTheWeek',
      validForNow: true,
      isClosed: false,
      openingHour: [{ dayFrom: 'Monday', dayTo: null, from: '09:00:00', to: '12:00:00' }],
    },
  ],
  contactDetails: {
    emails: [{ language: 'fi', value: 'diakonia@example.fi' }],
    phoneNumbers: [
      {
        number: '401234567',
        prefixNumber: '+358',
        language: 'fi',
        type: 'Phone',
        serviceChargeType: 'Chargeable',
      },
      { number: '91234567', prefixNumber: '+358', language: 'fi', type: 'Fax' },
    ],
    webPages: [{ url: 'https://example.fi/diakonia', value: 'Diakonia', language: 'fi' }],
    addresses: [
      {
        type: 'Postal',
        subType: 'PostOfficeBox',
        postOfficeBoxAddress: {
          postOfficeBox: [{ language: 'fi', value: 'PL 12' }],
          postalCode: '11101',
          municipality: { code: '694' },
        },
      },
    ],
  },
};

describe('connectionDetailsToDomain', () => {
  it('reads charge, descriptions by type, hours and contact details', () => {
    const details = connectionDetailsToDomain(wire);
    expect(details).toMatchObject({
      chargeType: 'Other',
      descriptions: { fi: 'Diakoniatyön vastaanotto' },
      chargeDescriptions: { fi: 'Materiaalimaksu' },
      emails: [{ language: 'fi', value: 'diakonia@example.fi' }],
      webPages: [{ language: 'fi', url: 'https://example.fi/diakonia', name: 'Diakonia' }],
      addresses: [{ kind: 'PostOfficeBox', postOfficeBox: { fi: 'PL 12' }, postalCode: '11101' }],
    });
    expect(details.serviceHours).toHaveLength(1);
    expect(details.phoneNumbers?.map((phone) => phone.type)).toEqual(['Phone', 'Fax']);
    expect(details.addresses?.[0]).not.toHaveProperty('purpose');
  });

  it('returns nothing for a connection without extra info', () => {
    expect(connectionDetailsToDomain({ serviceChargeType: null, contactDetails: null })).toEqual(
      {},
    );
  });
});

describe('connectionDetailsToWire', () => {
  it('writes the In shape: typed descriptions, faxes apart, postal addresses', () => {
    const body = connectionDetailsToWire(connectionDetailsToDomain(wire));
    expect(body).toMatchObject({
      serviceChargeType: 'Other',
      description: [
        { language: 'fi', value: 'Diakoniatyön vastaanotto', type: 'Description' },
        { language: 'fi', value: 'Materiaalimaksu', type: 'ChargeTypeAdditionalInfo' },
      ],
      contactDetails: {
        emails: [{ language: 'fi', value: 'diakonia@example.fi' }],
        phoneNumbers: [{ number: '401234567', prefixNumber: '+358', language: 'fi' }],
        faxNumbers: [{ number: '91234567', prefixNumber: '+358', language: 'fi' }],
        webPages: [{ url: 'https://example.fi/diakonia', value: 'Diakonia', language: 'fi' }],
        addresses: [
          {
            type: 'Postal',
            subType: 'PostOfficeBox',
            postOfficeBoxAddress: { postOfficeBox: [{ language: 'fi', value: 'PL 12' }] },
          },
        ],
      },
    });
    const contact = body.contactDetails as { phoneNumbers: Record<string, unknown>[] };
    expect(contact.phoneNumbers[0]).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('deleteAllDescriptions');
  });

  it('clears every empty field with its delete flag', () => {
    expect(connectionDetailsToWire({})).toEqual({
      deleteServiceChargeType: true,
      deleteAllDescriptions: true,
      deleteAllServiceHours: true,
      contactDetails: {
        deleteAllEmails: true,
        deleteAllPhones: true,
        deleteAllFaxNumbers: true,
        deleteAllWebPages: true,
        deleteAllAddresses: true,
      },
    });
  });

  it('writes a street address as a Postal Street address', () => {
    const body = connectionDetailsToWire({
      addresses: [
        { kind: 'Street', street: { fi: 'Kirkkokatu' }, streetNumber: '1', postalCode: '11100' },
      ],
    });
    expect((body.contactDetails as { addresses: unknown[] }).addresses).toEqual([
      {
        type: 'Postal',
        subType: 'Street',
        streetAddress: {
          street: [{ language: 'fi', value: 'Kirkkokatu' }],
          streetNumber: '1',
          postalCode: '11100',
        },
      },
    ]);
  });
});

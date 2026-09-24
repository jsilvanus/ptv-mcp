import { describe, expect, it } from 'vitest';
import type { ServiceChannel } from '../ptv/domain.js';
import { validateChannel } from './changeValidator.js';

function channel(overrides: Partial<ServiceChannel> = {}): ServiceChannel {
  return {
    id: '',
    organizationId: 'org',
    channelType: 'Phone',
    publishingStatus: 'Draft',
    names: { fi: 'Kirkkoherranvirasto' },
    summaries: { fi: 'Soita virastoon.' },
    descriptions: { fi: 'Saat neuvontaa puhelimitse.' },
    languages: ['fi'],
    phoneNumbers: [{ language: 'fi', prefixNumber: '+358', number: '19 123 4567' }],
    ...overrides,
  };
}

const fields = (c: ServiceChannel, creating = true) =>
  validateChannel(c, creating).errors.map((e) => e.field);

describe('validateChannel: channel fields', () => {
  it('accepts a complete new phone channel', () => {
    expect(validateChannel(channel(), true)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a leading 0, a missing number and a missing description', () => {
    expect(
      fields(
        channel({ phoneNumbers: [{ language: 'fi', prefixNumber: '+358', number: '019 123' }] }),
      ),
    ).toContain('phoneNumbers[0]');
    expect(fields(channel({ phoneNumbers: [] }))).toContain('phoneNumbers');
    expect(fields(channel({ descriptions: {} }))).toContain('descriptions.fi');
    // A Finnish service number has no prefix and may start with 0.
    expect(
      fields(
        channel({
          phoneNumbers: [{ language: 'fi', number: '020 634 0000', isFinnishServiceNumber: true }],
        }),
      ),
    ).toEqual([]);
  });

  it('checks urls, including tunnistautuminen.suomi.fi', () => {
    const errors = fields(
      channel({
        channelType: 'EChannel',
        phoneNumbers: [],
        urls: { fi: 'https://tunnistautuminen.suomi.fi/sso' },
      }),
    );
    expect(errors).toContain('urls.fi');
    expect(
      fields(
        channel({
          channelType: 'WebPage',
          phoneNumbers: [],
          names: { fi: 'a', sv: 'b' },
          descriptions: { fi: 'a', sv: 'b' },
          urls: { fi: 'www.example.fi' },
        }),
      ),
    ).toEqual(expect.arrayContaining(['urls.fi', 'urls']));
  });

  it('checks service hours and addresses', () => {
    const errors = fields(
      channel({
        channelType: 'ServiceLocation',
        phoneNumbers: [],
        serviceHours: [
          {
            type: 'DaysOfTheWeek',
            openingTimes: [{ dayFrom: 'Monday', from: '9.00', to: '15:00' }],
          },
          { type: 'Exceptional', isClosed: true },
          {
            type: 'DaysOfTheWeek',
            openingTimes: [{ dayFrom: 'Friday', from: '22:00', to: '02:00' }],
          },
        ],
        addresses: [{ kind: 'Street', street: { fi: 'Kirkkokatu 5' }, postalCode: '111' }],
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'serviceHours[0]',
        'serviceHours[1]',
        'serviceHours[2]',
        'addresses[0]',
      ]),
    );
    expect(
      fields(channel({ channelType: 'ServiceLocation', phoneNumbers: [], addresses: [] })),
    ).toContain('addresses');
  });

  it('only requires type fields on create or when the field is changed', () => {
    expect(fields(channel({ channelType: 'PrintableForm', phoneNumbers: [] }), false)).toEqual([]);
    expect(fields(channel({ channelType: 'PrintableForm', phoneNumbers: [] }), true)).toContain(
      'formFiles',
    );
  });
});

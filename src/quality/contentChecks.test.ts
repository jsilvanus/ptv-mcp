import { describe, expect, it } from 'vitest';
import type { Service, ServiceChannel } from '../ptv/domain.js';
import {
  checkChannel,
  checkService,
  classificationCode,
  type QualityReport,
} from './contentChecks.js';

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 's1',
    organizationId: 'o1',
    serviceType: 'Service',
    publishingStatus: 'Published',
    names: { fi: 'Rippikoulu' },
    summaries: { fi: 'Rippikoulu on 15-vuotiaille nuorille tarkoitettu leiri tai päiväkoulu.' },
    descriptions: {
      fi: 'Rippikoulussa tutustut kristinuskoon ja saat uusia ystäviä. Voit valita leirin tai päiväkoulun.\n\nIlmoittaudu rippikouluun verkossa.',
    },
    serviceClasses: [
      { uri: 'http://uri.suomi.fi/codelist/ptv/ptvserclass2/code/P27.1', names: {} },
    ],
    ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p1', names: {} }],
    targetGroups: [{ code: 'KR1', names: {} }],
    lifeEvents: [],
    industrialClasses: [],
    languages: ['fi'],
    serviceChannelIds: ['c1'],
    ...overrides,
  };
}

function channel(overrides: Partial<ServiceChannel> = {}): ServiceChannel {
  return {
    id: 'c1',
    organizationId: 'o1',
    channelType: 'ServiceLocation',
    publishingStatus: 'Published',
    names: { fi: 'Seurakuntakeskus' },
    descriptions: { fi: 'Seurakuntakeskuksessa on kerhotiloja ja kirkkoherranvirasto.' },
    languages: ['fi'],
    ...overrides,
  };
}

function ids(report: QualityReport): string[] {
  return report.findings.map((f) => f.checkId);
}

describe('checkService', () => {
  it('passes a well-formed service', () => {
    const result = checkService(service());
    expect(result.findings).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it('flags contact details and opening hours in free text as errors', () => {
    const result = checkService(
      service({
        descriptions: {
          fi: 'Soita numeroon 040 123 4567 tai lähetä sähköpostia kirkkoherranvirasto@example.fi. Lisätietoja www.example.fi. Toimisto on osoitteessa Kirkkokatu 5, 11100 Riihimäki ja auki klo 9–15.',
        },
      }),
    );
    const struct = result.findings.filter((f) => f.checkId === 'Q-STRUCT-1');
    expect(struct.map((f) => f.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('email address'),
        expect.stringContaining('web address'),
        expect.stringContaining('phone number'),
        expect.stringContaining('address'),
        expect.stringContaining('opening hours'),
      ]),
    );
    expect(struct.every((f) => f.severity === 'error' && f.language === 'fi')).toBe(true);
  });

  it('does not take ages, postcodes or short numbers for phone numbers', () => {
    const result = checkService(
      service({
        descriptions: { fi: 'Kerho on 3–5-vuotiaille lapsille. Ryhmässä on enintään 12 lasta.' },
      }),
    );
    expect(ids(result)).not.toContain('Q-STRUCT-1');
  });

  it('checks summary length, presence and repetition of the name', () => {
    expect(ids(checkService(service({ summaries: { fi: 'x'.repeat(151) } })))).toContain('Q-SUM-1');
    expect(ids(checkService(service({ summaries: { fi: 'Rippikoulu.' } })))).toContain('Q-SUM-1');
    const missing = checkService(
      service({
        names: { fi: 'Rippikoulu', sv: 'Skriftskola' },
        descriptions: { fi: 'Teksti.', sv: 'Text.' },
      }),
    );
    expect(missing.findings).toContainEqual(
      expect.objectContaining({ checkId: 'Q-SUM-1', language: 'sv', severity: 'error' }),
    );
  });

  it('checks description length', () => {
    const long = checkService(service({ descriptions: { fi: 'Sana. '.repeat(1000) } }));
    expect(long.findings).toContainEqual(
      expect.objectContaining({ checkId: 'Q-DESC-1', severity: 'error' }),
    );
  });

  it('checks classification limits', () => {
    const main = checkService(service({ serviceClasses: [{ code: 'P27', names: {} }] }));
    expect(main.findings).toContainEqual(expect.objectContaining({ checkId: 'Q-CLASS-1' }));
    const five = checkService(
      service({
        serviceClasses: ['P1.1', 'P2.1', 'P3.1', 'P4.1', 'P5.1'].map((code) => ({
          code,
          names: {},
        })),
      }),
    );
    expect(ids(five)).toContain('Q-CLASS-1');
    const noTerms = checkService(service({ ontologyTerms: [] }));
    expect(ids(noTerms)).toContain('Q-CLASS-2');
    const business = checkService(service({ targetGroups: [{ code: 'KR2', names: {} }] }));
    expect(ids(business)).toContain('Q-CLASS-3');
  });

  it('lets a general description supply the classifications', () => {
    const result = checkService(
      service({ generalDescriptionId: 'gd1', serviceClasses: [], ontologyTerms: [] }),
    );
    expect(ids(result)).not.toContain('Q-CLASS-1');
    expect(ids(result)).not.toContain('Q-CLASS-2');
  });

  it('requires connected channels and service languages', () => {
    const result = checkService(service({ serviceChannelIds: [], languages: [] }));
    expect(ids(result)).toEqual(expect.arrayContaining(['Q-STRUCT-5', 'Q-LANG-1']));
  });

  it('warns about the organisation name in the service name', () => {
    const result = checkService(service({ names: { fi: 'Riihimäen seurakunnan rippikoulu' } }), {
      organisationNames: { fi: 'Riihimäen seurakunta' },
    });
    // "seurakunnan" is not "seurakunta": only an exact containment is flagged.
    expect(ids(result)).not.toContain('Q-NAME-1');
    const exact = checkService(service({ names: { fi: 'Rippikoulu Riihimäen seurakunta' } }), {
      organisationNames: { fi: 'Riihimäen seurakunta' },
    });
    expect(ids(exact)).toContain('Q-NAME-1');
  });

  it('warns about Finnish style problems', () => {
    const result = checkService(
      service({
        descriptions: {
          fi: 'Rippikouluun haetaan keväällä, ja ilmoittautumiset käsitellään saapumisjärjestyksessä. Hakiessasi rippikouluun kerro toiveesi. Katso alta lisätietoja. Rippikoulu perustuu kirkkolakiin. Leiri alkaa 1.6.2027.',
        },
      }),
    );
    const warnings = result.findings.filter((f) => f.severity === 'warning');
    expect(warnings.map((f) => f.checkId)).toEqual(
      expect.arrayContaining(['Q-STYLE-2', 'Q-STYLE-4', 'Q-STRUCT-2', 'Q-LAW-1', 'Q-STYLE-7']),
    );
    const passive = warnings.find((f) => f.checkId === 'Q-STYLE-2');
    expect(passive?.message).toContain('haetaan');
    expect(passive?.message).toContain('käsitellään');
  });

  it('does not take case forms for passives or participials', () => {
    const result = checkService(
      service({
        descriptions: {
          fi: 'Kerro omista asioistaan tai tarpeitaan. Voit tulla itsellään sopivaan aikaan kuntaan. Tilanteessasi voit pyytää apua. Perheessäni on kolme lasta.',
        },
      }),
    );
    expect(ids(result)).not.toContain('Q-STYLE-2');
    expect(ids(result)).not.toContain('Q-STYLE-4');
  });

  it('warns about long sentences and paragraphs', () => {
    const sentence = `${'sana '.repeat(30).trim()}.`;
    const paragraph = 'Yksi. Kaksi. Kolme. Neljä. Viisi.';
    const result = checkService(service({ descriptions: { fi: `${sentence}\n\n${paragraph}` } }));
    const style = result.findings.filter((f) => f.checkId === 'Q-STYLE-3');
    expect(style).toHaveLength(2);
  });
});

describe('checkChannel', () => {
  it('passes a well-formed channel', () => {
    expect(checkChannel(channel(), { connectedServiceCount: 2 }).findings).toEqual([]);
  });

  it('flags a channel without services, languages or description', () => {
    const result = checkChannel(channel({ languages: [], descriptions: {} }), {
      connectedServiceCount: 0,
    });
    expect(ids(result)).toEqual(expect.arrayContaining(['Q-STRUCT-5', 'Q-LANG-1', 'Q-DESC-1']));
  });

  it('flags contact details in a channel description', () => {
    const result = checkChannel(channel({ descriptions: { fi: 'Soita +358 19 123 4567.' } }));
    expect(result.findings).toContainEqual(
      expect.objectContaining({ checkId: 'Q-STRUCT-1', severity: 'error' }),
    );
  });
});

describe('checkChannel: channel fields', () => {
  it('checks channel summaries like service summaries', () => {
    const result = checkChannel(channel({ summaries: { fi: 'Seurakuntakeskus' } }));
    expect(result.findings).toContainEqual(
      expect.objectContaining({ checkId: 'Q-SUM-1', severity: 'error' }),
    );
  });

  it('warns about phones, hours and a missing street address', () => {
    const result = checkChannel(
      channel({
        summaries: { fi: 'Kerhotilat ja virasto samassa talossa.' },
        phoneNumbers: [
          { language: 'fi', prefixNumber: '+358', number: '19 123 4567' },
          { language: 'fi', prefixNumber: '+358', number: '19 123 4568', chargeType: 'Other' },
        ],
        addresses: [{ kind: 'Other', latitude: '1', longitude: '2' }],
        serviceHours: [
          { type: 'Exceptional', validFrom: '2025-12-24', validTo: '2025-12-26', isClosed: true },
          {
            type: 'DaysOfTheWeek',
            openingTimes: [{ dayFrom: 'Monday', from: '09:00', to: '12:00' }],
          },
          {
            type: 'DaysOfTheWeek',
            openingTimes: [{ dayFrom: 'Monday', from: '13:00', to: '15:00' }],
          },
        ],
      }),
      { today: '2026-09-24' },
    );
    const messages = result.findings.map((f) => `${f.checkId} ${f.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('extra-charge number'),
        expect.stringContaining('Several numbers'),
        expect.stringContaining('No street visiting address'),
        expect.stringContaining('ended on 2025-12-26'),
        expect.stringContaining('Several weekly schedules'),
      ]),
    );
    expect(result.findings.every((f) => f.severity === 'warning')).toBe(true);
  });
});

describe('classificationCode', () => {
  it('reads the code from `code` or the uri', () => {
    expect(classificationCode({ code: 'KR1', names: {} })).toBe('KR1');
    expect(
      classificationCode({
        uri: 'http://uri.suomi.fi/codelist/ptv/ptvserclass2/code/P27.1',
        names: {},
      }),
    ).toBe('P27.1');
  });
});

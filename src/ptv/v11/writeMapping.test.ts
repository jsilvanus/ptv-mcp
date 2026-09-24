import { describe, expect, it } from 'vitest';
import type { Service } from '../domain.js';
import { newServiceToV11Body, serviceChangesToV11Body } from './writeMapping.js';
import { toPublishingStatus } from './mappers/common.js';
import type { V11ServiceWire } from './wireModel.js';

describe('serviceChangesToV11Body', () => {
  it('sends serviceNames whenever names is present', () => {
    const body = serviceChangesToV11Body({ names: { fi: 'Uusi nimi' } });
    expect(body.serviceNames).toEqual([{ language: 'fi', value: 'Uusi nimi', type: 'Name' }]);
  });

  it('combines summaries and descriptions into serviceDescriptions with the right type labels', () => {
    const body = serviceChangesToV11Body({
      summaries: { fi: 'Tiivistelmä' },
      descriptions: { fi: 'Kuvaus' },
    });
    expect(body.serviceDescriptions).toEqual(
      expect.arrayContaining([
        { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
        { language: 'fi', value: 'Kuvaus', type: 'Description' },
      ]),
    );
  });

  it('writes serviceClasses as URIs, not codes (confirmed against v11 write schema)', () => {
    const body = serviceChangesToV11Body({
      serviceClasses: [{ code: 'P1', uri: 'http://example/P1', names: {} }],
    });
    expect(body.serviceClasses).toEqual(['http://example/P1']);
  });

  it('writes industrialClasses as TOL 2008 URIs (a plain code makes PTV answer 500)', () => {
    const body = serviceChangesToV11Body({
      industrialClasses: [
        { code: '94910', names: {} },
        {
          code: '36000',
          uri: 'http://www.stat.fi/meta/luokitukset/toimiala/001-2008/36000',
          names: {},
        },
      ],
    });
    expect(body.industrialClasses).toEqual([
      'http://www.stat.fi/meta/luokitukset/toimiala/001-2008/94910',
      'http://www.stat.fi/meta/luokitukset/toimiala/001-2008/36000',
    ]);
  });

  it('sets the delete flag when clearing a field that has one (lifeEvents)', () => {
    const body = serviceChangesToV11Body({ lifeEvents: [] });
    expect(body.deleteAllLifeEvents).toBe(true);
    expect(body.lifeEvents).toBeUndefined();
  });

  it('sets the delete flag when clearing generalDescriptionId', () => {
    const body = serviceChangesToV11Body({ generalDescriptionId: undefined as unknown as string });
    // generalDescriptionId is `in` the object even when the value is undefined,
    // since the proposal explicitly included the key to signal "clear this".
    expect(body.deleteGeneralDescriptionId).toBe(true);
  });

  it('sends an explicit empty array for a full-replace field being cleared (serviceClasses)', () => {
    const body = serviceChangesToV11Body({ serviceClasses: [] });
    expect(body.serviceClasses).toEqual([]);
    expect(body.deleteAllServiceClasses).toBeUndefined();
  });

  it('omits fields the proposal does not touch at all', () => {
    const body = serviceChangesToV11Body({ names: { fi: 'X' } });
    expect('lifeEvents' in body).toBe(false);
    expect('languages' in body).toBe(false);
  });

  it('sends languages verbatim when present', () => {
    const changes: Partial<Service> = { languages: ['fi', 'sv'] };
    const body = serviceChangesToV11Body(changes);
    expect(body.languages).toEqual(['fi', 'sv']);
  });

  describe('with the current wire record (live PUT requirements)', () => {
    const current: V11ServiceWire = {
      id: 'c67da57e-ea12-4c90-bd53-1fa5f82e26af',
      type: 'Service',
      generalDescriptionId: null,
      publishingStatus: 'Published',
      serviceNames: [
        { language: 'fi', value: 'Hautauspalvelu', type: 'Name' },
        { language: 'fi', value: 'Hautaus', type: 'AlternativeName' },
      ],
      serviceDescriptions: [
        { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
        { language: 'fi', value: null, type: 'UserInstruction' },
        { language: 'fi', value: 'Kuvaus', type: 'Description' },
        { language: 'fi', value: 'Ohje', type: 'ChargeTypeAdditionalInfo' },
      ],
      serviceClasses: [{ name: [], code: 'P11', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1105' }],
      ontologyTerms: [{ name: [], code: null, uri: 'http://www.yso.fi/onto/koko/p34462' }],
      targetGroups: [{ name: [], code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001' }],
      lifeEvents: [],
      industrialClasses: [],
      languages: ['fi'],
      organizations: [],
      serviceChannels: null,
      modified: '2026-04-09T12:25:48.494962',
    };

    it('always sends publishingStatus, from the change or else the current record', () => {
      expect(serviceChangesToV11Body({ names: { fi: 'X' } }, current).publishingStatus).toBe(
        'Published',
      );
      expect(serviceChangesToV11Body({ publishingStatus: 'Draft' }, current).publishingStatus).toBe(
        'Draft',
      );
    });

    it('refuses Modified, which locks the service against later API writes', () => {
      expect(() => serviceChangesToV11Body({ publishingStatus: 'Modified' }, current)).toThrow(
        /locks the service/,
      );
    });

    it('writes Archived as v11 Deleted and refuses Withdrawn', () => {
      expect(
        serviceChangesToV11Body({ publishingStatus: 'Archived' }, current).publishingStatus,
      ).toBe('Deleted');
      expect(() => serviceChangesToV11Body({ publishingStatus: 'Withdrawn' }, current)).toThrow(
        /Withdrawn/,
      );
    });

    describe('with a general description linked', () => {
      const linked: V11ServiceWire = {
        ...current,
        generalDescriptionId: 'gd-1',
        serviceClasses: [
          ...current.serviceClasses,
          { name: [], code: 'P25.5', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1203' },
        ],
      };
      const inherited = new Set(['http://urn.fi/URN:NBN:fi:au:ptvl:v1203']);

      it('does not resend the classifications, which are not required then', () => {
        const body = serviceChangesToV11Body({ names: { fi: 'X' } }, linked, inherited);
        expect('serviceClasses' in body).toBe(false);
        expect('targetGroups' in body).toBe(false);
      });

      it("on unlink sends the type and resends only the service's own classifications", () => {
        const body = serviceChangesToV11Body(
          { generalDescriptionId: null as unknown as string },
          linked,
          inherited,
        );
        expect(body.deleteGeneralDescriptionId).toBe(true);
        expect(body.type).toBe('Service');
        expect(body.serviceClasses).toEqual(['http://urn.fi/URN:NBN:fi:au:ptvl:v1105']);
      });

      it("keeps a list whole when every entry is also the general description's", () => {
        const body = serviceChangesToV11Body(
          { generalDescriptionId: null as unknown as string },
          linked,
          new Set([...inherited, 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001']),
        );
        expect(body.targetGroups).toEqual(['http://urn.fi/URN:NBN:fi:au:ptvl:v2001']);
      });

      it('keeps inherited entries out of a list the change sends', () => {
        const body = serviceChangesToV11Body(
          {
            serviceClasses: [
              { uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1203', names: {} },
              { uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} },
            ],
          },
          linked,
          inherited,
        );
        expect(body.serviceClasses).toEqual(['http://urn.fi/URN:NBN:fi:au:ptvl:v1111']);
      });
    });

    it('maps a serviceType change to type', () => {
      expect(serviceChangesToV11Body({ serviceType: 'PermitOrObligation' }, current).type).toBe(
        'PermitOrObligation',
      );
    });

    it('resends the classifications PTV requires when there is no general description', () => {
      const body = serviceChangesToV11Body({ names: { fi: 'X' } }, current);
      expect(body.serviceClasses).toEqual(['http://urn.fi/URN:NBN:fi:au:ptvl:v1105']);
      expect(body.ontologyTerms).toEqual(['http://www.yso.fi/onto/koko/p34462']);
      expect(body.targetGroups).toEqual(['http://urn.fi/URN:NBN:fi:au:ptvl:v2001']);
    });

    it('keeps the summary and other description types when only the description changes', () => {
      const body = serviceChangesToV11Body({ descriptions: { fi: 'Uusi kuvaus' } }, current);
      expect(body.serviceDescriptions).toEqual([
        { language: 'fi', value: 'Ohje', type: 'ChargeTypeAdditionalInfo' },
        { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
        { language: 'fi', value: 'Uusi kuvaus', type: 'Description' },
      ]);
    });

    it('keeps alternative names when the name changes', () => {
      const body = serviceChangesToV11Body({ names: { fi: 'Uusi' } }, current);
      expect(body.serviceNames).toEqual([
        { language: 'fi', value: 'Hautaus', type: 'AlternativeName' },
        { language: 'fi', value: 'Uusi', type: 'Name' },
      ]);
    });

    it('lets a change replace a required classification list', () => {
      const body = serviceChangesToV11Body(
        { ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p1', names: {} }] },
        current,
      );
      expect(body.ontologyTerms).toEqual(['http://www.yso.fi/onto/koko/p1']);
    });
  });
});

describe('toPublishingStatus', () => {
  it('reads Modified as is and Deleted as Archived', () => {
    expect(toPublishingStatus('Modified')).toBe('Modified');
    expect(toPublishingStatus('Deleted')).toBe('Archived');
  });
});

describe('newServiceToV11Body', () => {
  it('fills the fields PTV requires on POST that the domain model does not carry', () => {
    const body = newServiceToV11Body({
      organizationId: 'org-15',
      serviceType: 'Service',
      publishingStatus: 'Draft',
      names: { fi: 'Kastekoulu' },
      summaries: { fi: 'Tiivistelmä' },
      descriptions: { fi: 'Kuvaus' },
      serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
      ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
      targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
      lifeEvents: [],
      industrialClasses: [],
      languages: ['fi'],
      serviceChannelIds: ['channel-1'],
    });
    expect(body).toEqual({
      type: 'Service',
      publishingStatus: 'Draft',
      serviceNames: [{ language: 'fi', value: 'Kastekoulu', type: 'Name' }],
      serviceDescriptions: [
        { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
        { language: 'fi', value: 'Kuvaus', type: 'Description' },
      ],
      languages: ['fi'],
      serviceClasses: ['http://urn.fi/URN:NBN:fi:au:ptvl:v1111'],
      ontologyTerms: ['http://www.yso.fi/onto/koko/p34462'],
      targetGroups: ['http://urn.fi/URN:NBN:fi:au:ptvl:v2001'],
      lifeEvents: [],
      industrialClasses: [],
      fundingType: 'PubliclyFunded',
      areaType: 'Nationwide',
      mainResponsibleOrganization: 'org-15',
      serviceProducers: [{ provisionType: 'SelfProducedServices', organizations: ['org-15'] }],
      serviceChannels: ['channel-1'],
    });
  });
});

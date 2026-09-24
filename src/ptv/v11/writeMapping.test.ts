import { describe, expect, it } from 'vitest';
import type { Service } from '../domain.js';
import { serviceChangesToV11Body } from './writeMapping.js';
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

  it('writes industrialClasses as codes, not URIs', () => {
    const body = serviceChangesToV11Body({
      industrialClasses: [{ code: '12345', uri: 'http://example/12345', names: {} }],
    });
    expect(body.industrialClasses).toEqual(['12345']);
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

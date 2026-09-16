import { describe, expect, it } from 'vitest';
import type { Service } from '../domain.js';
import { serviceChangesToV11Body } from './writeMapping.js';

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
});

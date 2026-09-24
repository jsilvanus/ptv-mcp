import { describe, expect, it } from 'vitest';
import { channelChangesToV11Body } from './channelWriteMapping.js';
import type { V11ServiceChannelWire } from './wireModel.js';

function channel(overrides: Partial<V11ServiceChannelWire> = {}): V11ServiceChannelWire {
  return {
    id: 'ch-1',
    serviceChannelType: 'ServiceLocation',
    organizationId: 'org-15',
    publishingStatus: 'Published',
    serviceChannelNames: [
      { language: 'fi', value: 'Hautaustoimi', type: 'Name' },
      { language: 'sv', value: 'Begravning', type: 'Name' },
    ],
    serviceChannelDescriptions: [
      { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
      { language: 'fi', value: 'Kuvaus', type: 'Description' },
      { language: 'sv', value: 'Sammandrag', type: 'Summary' },
      { language: 'sv', value: 'Beskrivning', type: 'Description' },
    ],
    languages: ['fi', 'sv'],
    modified: '2026-09-24T00:00:00',
    ...overrides,
  };
}

describe('channelChangesToV11Body', () => {
  it('always sends publishingStatus and replaces only the Description entries', () => {
    expect(channelChangesToV11Body({ descriptions: { fi: 'Uusi' } }, channel())).toEqual({
      publishingStatus: 'Published',
      serviceChannelDescriptions: [
        { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
        { language: 'sv', value: 'Sammandrag', type: 'Summary' },
        { language: 'fi', value: 'Uusi', type: 'Description' },
      ],
    });
  });

  it('drops every text of a removed language', () => {
    const body = channelChangesToV11Body({ languages: ['fi'] }, channel());
    expect(body.languages).toEqual(['fi']);
    expect(body.serviceChannelNames).toEqual([
      { language: 'fi', value: 'Hautaustoimi', type: 'Name' },
    ]);
    expect(body.serviceChannelDescriptions).toEqual([
      { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
      { language: 'fi', value: 'Kuvaus', type: 'Description' },
    ]);
  });

  it('resends requiresAuthentication, required on an EChannel PUT', () => {
    const body = channelChangesToV11Body(
      { names: { fi: 'Chat' } },
      channel({ serviceChannelType: 'EChannel', requiresAuthentication: true }),
    );
    expect(body.requiresAuthentication).toBe(true);
    expect(channelChangesToV11Body({}, channel()).requiresAuthentication).toBeUndefined();
  });

  it('writes Archived as Deleted', () => {
    expect(channelChangesToV11Body({ publishingStatus: 'Archived' }, channel())).toEqual({
      publishingStatus: 'Deleted',
    });
  });
});

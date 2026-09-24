import { describe, expect, it } from 'vitest';
import { planServiceConnections } from './connectionWrite.js';
import type { V11ServiceWire } from './wireModel.js';

function service(relations: V11ServiceWire['serviceChannels']): V11ServiceWire {
  return {
    id: 's1',
    type: 'Service',
    publishingStatus: 'Published',
    serviceNames: [],
    serviceDescriptions: [],
    serviceClasses: [],
    ontologyTerms: [],
    targetGroups: [],
    lifeEvents: [],
    industrialClasses: [],
    languages: ['fi'],
    organizations: [],
    serviceChannels: relations,
    modified: '2026-09-24T00:00:00',
  };
}

const withExtraInfo = {
  serviceChannel: { id: 'a' },
  serviceChargeType: 'Chargeable',
  description: [
    { language: 'fi', value: 'Lisätieto', type: 'Description' },
    { language: 'sv', value: null, type: 'Description' },
  ],
  serviceHours: [],
  contactDetails: null,
};

describe('planServiceConnections', () => {
  it('does nothing when the connections already match', () => {
    expect(planServiceConnections(service([{ serviceChannel: { id: 'a' } }]), ['a'])).toEqual([]);
    expect(planServiceConnections(service(null), [])).toEqual([]);
  });

  it('adds new channels in one call, without touching the existing ones', () => {
    expect(
      planServiceConnections(service([{ serviceChannel: { id: 'a' } }]), ['a', 'b', 'c']),
    ).toEqual([{ channelRelations: [{ serviceChannelId: 'b' }, { serviceChannelId: 'c' }] }]);
  });

  it('removes by deleting all and re-adding the rest with their extra info', () => {
    expect(
      planServiceConnections(service([withExtraInfo, { serviceChannel: { id: 'b' } }]), ['a', 'c']),
    ).toEqual([
      { deleteAllChannelRelations: true, channelRelations: [] },
      {
        channelRelations: [
          {
            serviceChannelId: 'a',
            serviceChargeType: 'Chargeable',
            description: [{ language: 'fi', value: 'Lisätieto', type: 'Description' }],
          },
          { serviceChannelId: 'c' },
        ],
      },
    ]);
  });

  it('removes every connection with a single delete-all call', () => {
    expect(planServiceConnections(service([{ serviceChannel: { id: 'a' } }]), [])).toEqual([
      { deleteAllChannelRelations: true, channelRelations: [] },
    ]);
  });
});

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
  it('does nothing when the connections already match, in any order', () => {
    expect(
      planServiceConnections(
        service([{ serviceChannel: { id: 'a' } }, { serviceChannel: { id: 'b' } }]),
        ['b', 'a'],
      ),
    ).toBeNull();
    expect(planServiceConnections(service(null), [])).toBeNull();
  });

  it('lists every desired channel, since the PUT replaces the connections (live)', () => {
    expect(planServiceConnections(service([{ serviceChannel: { id: 'a' } }]), ['a', 'b'])).toEqual({
      channelRelations: [{ serviceChannelId: 'a' }, { serviceChannelId: 'b' }],
    });
  });

  it('keeps the extra info of connections that stay and drops removed ones', () => {
    expect(
      planServiceConnections(service([withExtraInfo, { serviceChannel: { id: 'b' } }]), ['a', 'c']),
    ).toEqual({
      channelRelations: [
        {
          serviceChannelId: 'a',
          serviceChargeType: 'Chargeable',
          description: [{ language: 'fi', value: 'Lisätieto', type: 'Description' }],
        },
        { serviceChannelId: 'c' },
      ],
    });
  });

  it('removes every connection with delete-all and an empty list', () => {
    expect(planServiceConnections(service([{ serviceChannel: { id: 'a' } }]), [])).toEqual({
      deleteAllChannelRelations: true,
      channelRelations: [],
    });
  });
});

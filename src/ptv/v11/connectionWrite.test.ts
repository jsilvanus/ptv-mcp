import { describe, expect, it } from 'vitest';
import { planConnectionDetails, planServiceConnections } from './connectionWrite.js';
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

describe('planConnectionDetails', () => {
  it('changes one connection and resends the others as they are', () => {
    const body = planConnectionDetails(
      service([withExtraInfo, { serviceChannel: { id: 'b' } }]),
      'a',
      { chargeType: 'FreeOfCharge' },
    );
    expect(body.channelRelations).toHaveLength(2);
    expect(body.channelRelations[0]).toMatchObject({
      serviceChannelId: 'a',
      serviceChargeType: 'FreeOfCharge',
      description: [{ language: 'fi', value: 'Lisätieto', type: 'Description' }],
    });
    expect(body.channelRelations[1]).toEqual({ serviceChannelId: 'b' });
    expect(body).not.toHaveProperty('deleteAllChannelRelations');
  });

  it('clears a field given empty', () => {
    const body = planConnectionDetails(service([withExtraInfo]), 'a', { descriptions: {} });
    expect(body.channelRelations[0]).toMatchObject({
      serviceChargeType: 'Chargeable',
      deleteAllDescriptions: true,
    });
    expect(body.channelRelations[0]).not.toHaveProperty('description');
  });

  it('refuses a channel the service is not connected to', () => {
    expect(() => planConnectionDetails(service(null), 'a', {})).toThrow(/not connected/);
  });
});

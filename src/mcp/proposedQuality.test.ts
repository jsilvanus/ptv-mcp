import { describe, expect, it } from 'vitest';
import type { ServiceChannel } from '../ptv/domain.js';
import { proposedQuality } from './proposalQueue.js';

const newChannel = {
  id: '',
  channelType: 'Phone',
  organizationId: 'org',
  publishingStatus: 'Draft',
  names: { fi: 'Neuvontapuhelin' },
  summaries: { fi: 'Soita, kun tarvitset apua ilmoittautumisessa.' },
  descriptions: { fi: 'Saat apua ilmoittautumisessa.' },
  languages: ['fi'],
} as ServiceChannel;

const structFindings = (serviceIds?: string[]) =>
  proposedQuality('channel_create', {
    ...newChannel,
    ...(serviceIds ? { serviceIds } : {}),
  })!.findings.filter((finding) => finding.checkId === 'Q-STRUCT-5');

describe('proposedQuality', () => {
  it('warns (not errors) about a new channel that is not connected yet', () => {
    expect(structFindings()).toEqual([
      expect.objectContaining({ severity: 'warning', field: 'serviceIds' }),
    ]);
    expect(structFindings(['service-1'])).toEqual([]);
  });

  it('warns about a new service without channels, errors on an existing one', () => {
    const service = {
      organizationId: 'org',
      serviceType: 'Service',
      publishingStatus: 'Draft',
      names: { fi: 'Rippikoulu' },
      summaries: { fi: 'Rippikoulussa valmistaudut konfirmaatioon.' },
      descriptions: { fi: 'Rippikoulu kestää puoli vuotta.' },
      serviceClasses: [],
      ontologyTerms: [],
      targetGroups: [],
      lifeEvents: [],
      industrialClasses: [],
      languages: ['fi'],
      serviceChannelIds: [],
    } as unknown as Parameters<typeof proposedQuality>[1];
    const severity = (kind: 'service_create' | 'service_update') =>
      proposedQuality(kind, service)!.findings.find((f) => f.checkId === 'Q-STRUCT-5')?.severity;
    expect(severity('service_create')).toBe('warning');
    expect(severity('service_update')).toBe('error');
  });

  it('leaves Q-STRUCT-5 of a channel update to the review item', () => {
    const report = proposedQuality('channel_update', newChannel)!;
    expect(report.findings.filter((f) => f.checkId === 'Q-STRUCT-5')).toEqual([]);
  });
});

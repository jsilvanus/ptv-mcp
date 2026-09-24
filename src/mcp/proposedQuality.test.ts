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
  it('flags a new channel that is not connected to any service', () => {
    expect(structFindings()).toHaveLength(1);
    expect(structFindings(['service-1'])).toEqual([]);
  });

  it('leaves Q-STRUCT-5 of a channel update to the review item', () => {
    const report = proposedQuality('channel_update', newChannel)!;
    expect(report.findings.filter((f) => f.checkId === 'Q-STRUCT-5')).toEqual([]);
  });
});

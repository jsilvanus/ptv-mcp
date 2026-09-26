import type { ProposalKind } from '../proposals/proposalService.js';

/** Kinds that create a new item: PTV assigns its id when it is applied or entered. */
export function isCreateKind(kind: ProposalKind): boolean {
  return kind === 'service_create' || kind === 'channel_create' || kind === 'organisation_create';
}

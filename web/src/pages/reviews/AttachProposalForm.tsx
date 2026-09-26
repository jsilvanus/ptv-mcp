import { useState } from 'react';

/**
 * A Publisher attaches a draft proposal (made in the MCP) to the item: the
 * item reopens and its reviewer becomes a required reviewer of the draft.
 */
export function AttachProposalForm({
  busy,
  onAttach,
}: {
  busy: boolean;
  onAttach(proposalId: string): Promise<boolean>;
}) {
  const [proposalId, setProposalId] = useState('');
  return (
    <p style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <span>
        <label htmlFor="attach-proposal">Attach a draft proposal for the reviewer</label>
        <br />
        <input
          id="attach-proposal"
          placeholder="Proposal id"
          value={proposalId}
          onChange={(e) => setProposalId(e.target.value)}
        />
      </span>
      <button
        disabled={busy || !proposalId.trim()}
        onClick={() =>
          void onAttach(proposalId.trim()).then((ok) => {
            if (ok) setProposalId('');
          })
        }
      >
        Attach
      </button>
    </p>
  );
}

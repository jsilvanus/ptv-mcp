import { useState } from 'react';
import { apiFetch } from '../../api/client';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { ProposalPreview } from '../ProposalPreview';
import { QualityFindings } from '../QualityFindings';
import { PROPOSAL_KIND_LABELS } from '../ptvLabels';
import { AttachProposalForm } from './AttachProposalForm';
import { KIND_LABELS, STATUS_LABELS, type ReviewItemDetails } from './labels';

/**
 * One review item: its current PTV content, automated checks and linked
 * proposals, and the reviewer's confirm/send actions (Publishers can also
 * attach proposals and send the item back).
 */
export function ItemPanel({
  tenantId,
  item,
  canManage,
  onChanged,
  onClose,
}: {
  tenantId: string;
  item: ReviewItemDetails;
  canManage: boolean;
  /** Refreshes the page after a successful action. */
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const [note, setNote] = useState(item.note ?? '');
  const { busy, error, run } = useAsyncAction();
  const post = (path: string, body: object, fallback: string) =>
    run(async () => {
      await apiFetch(`/tenants/${tenantId}/review-items/${item.id}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await onChanged();
    }, fallback);
  const pending = item.proposals.filter((p) => p.status === 'pending').length;

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>
        {KIND_LABELS[item.targetKind]}: {item.targetName}
      </h2>
      <p>
        <strong>Status:</strong> {STATUS_LABELS[item.status]}
        {item.reviewedByName && ` (${item.reviewedByName})`}
        <br />
        <strong>PTV id:</strong> {item.targetId}
        <br />
        <strong>Reviewer:</strong> {item.assigneeName ?? 'unassigned'}
      </p>
      {item.current ? (
        <ProposalPreview key={item.id} entity={item.current} title="Current content in PTV" />
      ) : (
        <p className="muted">The content can no longer be read from PTV.</p>
      )}
      {item.quality && (
        <>
          <h3>Automated checks</h3>
          <QualityFindings findings={item.quality.findings} />
        </>
      )}
      <h3>Proposals</h3>
      {item.proposals.length === 0 ? (
        <p className="muted">
          None yet. To change the content, ask your AI assistant to draft proposals for review item{' '}
          <code>{item.id}</code> (it passes this id as reviewItemId).
        </p>
      ) : (
        <ul>
          {item.proposals.map((p) => (
            <li key={p.id}>
              {PROPOSAL_KIND_LABELS[p.kind]} · {p.status} · <code>{p.id}</code>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <AttachProposalForm
          busy={busy}
          onAttach={(proposalId) =>
            post('attach', { proposalId }, 'Could not attach the proposal.')
          }
        />
      )}
      <label htmlFor="review-note">Note</label>
      <br />
      <textarea
        id="review-note"
        rows={3}
        style={{ width: '100%' }}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {item.status === 'open' && (
          <>
            <button
              className="primary"
              disabled={busy || pending > 0}
              title={pending > 0 ? 'Linked proposals are still pending' : undefined}
              onClick={() =>
                void post(
                  'complete',
                  { decision: 'confirmed', note },
                  'Could not confirm the item.',
                )
              }
            >
              Confirm: up to date
            </button>
            <button
              className="primary"
              disabled={busy || item.proposals.length === 0}
              onClick={() =>
                void post(
                  'complete',
                  { decision: 'changes_proposed', note },
                  'Could not send the item.',
                )
              }
            >
              Send changes for publishing
            </button>
          </>
        )}
        {item.status !== 'open' && canManage && (
          <button
            disabled={busy}
            onClick={() => void post('reopen', { note }, 'Could not send the item back.')}
          >
            Send back to reviewer
          </button>
        )}
        <button onClick={onClose}>Close</button>
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

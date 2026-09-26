import { useState, type FormEvent } from 'react';
import { apiFetch } from '../api/client';
import { useAsyncAction } from '../hooks/useAsyncAction';
import type { ProposalComment } from '../api/types';

/**
 * Discussion on one proposal (docs/roles-and-review-plan.md, step 3). Any
 * Contributor+ can comment; comments stay after the proposal is resolved.
 */
export function ProposalComments({
  tenantId,
  proposalId,
  comments,
  onAdded,
}: {
  tenantId: string;
  proposalId: string;
  comments: ProposalComment[];
  onAdded: () => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const { busy: sending, error, run } = useAsyncAction();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft.trim()) return;
    await run(async () => {
      await apiFetch(`/tenants/${tenantId}/proposals/${proposalId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ comment: draft }),
      });
      setDraft('');
      await onAdded();
    }, 'Could not add comment.');
  }

  return (
    <section>
      <h3>Comments</h3>
      {comments.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {comments.map((comment) => (
            <li key={comment.id}>
              <strong>{comment.userName}</strong>{' '}
              <span className="muted">{new Date(comment.createdAt).toLocaleString('fi-FI')}</span>
              <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void handleSubmit(event)} style={{ display: 'grid', gap: 8 }}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Write a comment"
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          {sending ? 'Sending…' : 'Add comment'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

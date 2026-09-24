import { useEffect, useState } from 'react';
import { ApiError, apiFetch, currentUserId } from '../api/client';
import type { ProposalDetails, ReviewCandidate, ReviewDecision } from '../api/types';

const DECISION_LABELS: Record<ReviewDecision, string> = {
  pending: 'Odottaa',
  approved: 'Hyväksyn',
  changes_requested: 'Pyydän muutoksia',
};

/**
 * Required reviewers of one proposal (docs/roles-and-review-plan.md,
 * step 5): the list with sign-offs, the reviewer's own sign-off, and, for
 * the proposer or an Approver+, naming more reviewers.
 */
export function ProposalReviewers({
  tenantId,
  proposal,
  canResolve,
  onChanged,
}: {
  tenantId: string;
  proposal: ProposalDetails;
  canResolve: boolean;
  onChanged: () => Promise<void>;
}) {
  const me = currentUserId();
  const reviewers = proposal.reviewers ?? [];
  const pending = proposal.status === 'pending';
  const myReview = reviewers.find((reviewer) => reviewer.userId === me);
  const canRequest = pending && (canResolve || proposal.proposedByUserId === me);

  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [chosen, setChosen] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRequest) return;
    apiFetch<ReviewCandidate[]>(`/tenants/${tenantId}/review-candidates`)
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [tenantId, canRequest]);

  const available = candidates.filter(
    (candidate) =>
      candidate.userId !== proposal.proposedByUserId &&
      !reviewers.some((reviewer) => reviewer.userId === candidate.userId),
  );

  async function run(action: () => Promise<unknown>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const requestReview = () =>
    run(async () => {
      await apiFetch(`/tenants/${tenantId}/proposals/${proposal.id}/reviewers`, {
        method: 'POST',
        body: JSON.stringify({ reviewers: [chosen] }),
      });
      setChosen('');
    }, 'Could not request review.');

  const signOff = (decision: Exclude<ReviewDecision, 'pending'>) =>
    run(async () => {
      await apiFetch(`/tenants/${tenantId}/proposals/${proposal.id}/sign-off`, {
        method: 'POST',
        body: JSON.stringify({ decision, ...(comment.trim() ? { comment } : {}) }),
      });
      setComment('');
    }, 'Could not save sign-off.');

  if (reviewers.length === 0 && !canRequest) return null;

  return (
    <section>
      <h3>Reviewers</h3>
      {reviewers.length === 0 ? (
        <p className="muted">No required reviewers.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {reviewers.map((reviewer) => (
            <li key={reviewer.userId}>
              <strong>{reviewer.userName}</strong> · {DECISION_LABELS[reviewer.decision]}
              {reviewer.comment && (
                <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{reviewer.comment}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {pending && myReview && (
        <div style={{ display: 'grid', gap: 8 }}>
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={2}
            maxLength={4000}
            placeholder="Comment for your sign-off (optional)"
          />
          <p style={{ display: 'flex', gap: 8, margin: 0 }}>
            <button className="primary" disabled={busy} onClick={() => void signOff('approved')}>
              Hyväksyn
            </button>
            <button disabled={busy} onClick={() => void signOff('changes_requested')}>
              Pyydän muutoksia
            </button>
          </p>
        </div>
      )}

      {canRequest && available.length > 0 && (
        <p style={{ display: 'flex', gap: 8 }}>
          <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">Choose a reviewer…</option>
            {available.map((candidate) => (
              <option key={candidate.userId} value={candidate.userId}>
                {candidate.name} ({candidate.email})
              </option>
            ))}
          </select>
          <button disabled={busy || !chosen} onClick={() => void requestReview()}>
            Request review
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

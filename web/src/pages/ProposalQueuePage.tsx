import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, apiFetch, errorMessage } from '../api/client';
import type {
  ProposalDetails,
  ProposalResolveAction,
  ProposalStatus,
  ProposalSummary,
} from '../api/types';
import { useTenants } from '../tenants/TenantContext';
import { DiffView } from './DiffView';
import { ProposalComments } from './ProposalComments';
import { ProposalReviewers } from './ProposalReviewers';
import { ProposalPreview } from './ProposalPreview';
import { ManualPublishPanel } from './ManualPublishPanel';
import { QualityFindings } from './QualityFindings';
import { PROPOSAL_KIND_LABELS } from './ptvLabels';
import { roleAtLeast } from '../auth/roles';

const STATUSES: ProposalStatus[] = ['pending', 'approved', 'rejected', 'applied', 'failed'];
/** Filter value for pending proposals waiting for the user's own sign-off. */
const WAITING_FOR_ME = 'waiting';
type StatusFilter = ProposalStatus | typeof WAITING_FOR_ME;

export function ProposalQueuePage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { currentTenant } = useTenants();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [items, setItems] = useState<ProposalSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProposalDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [resolvingAction, setResolvingAction] = useState<ProposalResolveAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Contributors view proposals; resolving needs Approver, applying Publisher.
  const canReview = roleAtLeast(currentTenant?.role, 'contributor');
  const canResolve = roleAtLeast(currentTenant?.role, 'approver');
  const canApply = roleAtLeast(currentTenant?.role, 'publisher');

  const loadList = useCallback(async () => {
    if (!tenantId || !canReview) return;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const list = await apiFetch<ProposalSummary[]>(
        status === WAITING_FOR_ME
          ? `/tenants/${tenantId}/proposals?waitingForMe=true`
          : `/tenants/${tenantId}/proposals?status=${status}`,
      );
      setItems(list);
      if (list.length === 0) {
        setSelectedId(null);
        setSelected(null);
      } else {
        // Keep the selection while it is still in the list.
        setSelectedId((current) =>
          current && list.some((proposal) => proposal.id === current)
            ? current
            : (list[0]?.id ?? null),
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(errorMessage(err, 'Could not load proposal queue.'));
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId, status, canReview]);

  const loadSelected = useCallback(async () => {
    if (!tenantId || !selectedId || !canReview) return;
    setLoadingDetails(true);
    setError(null);
    try {
      const details = await apiFetch<ProposalDetails>(
        `/tenants/${tenantId}/proposals/${selectedId}`,
      );
      setSelected(details);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(errorMessage(err, 'Could not load proposal details.'));
      }
    } finally {
      setLoadingDetails(false);
    }
  }, [tenantId, selectedId, canReview]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadSelected();
  }, [loadSelected]);

  async function resolve(action: ProposalResolveAction): Promise<void> {
    if (!tenantId || !selectedId) return;
    setResolvingAction(action);
    setError(null);
    try {
      const updated = await apiFetch<ProposalDetails>(
        `/tenants/${tenantId}/proposals/${selectedId}/resolve`,
        {
          method: 'POST',
          body: JSON.stringify({ action }),
        },
      );
      setSelected(updated);
      await loadList();
    } catch (err) {
      setError(errorMessage(err, 'Could not resolve proposal.'));
    } finally {
      setResolvingAction(null);
    }
  }

  if (!canReview) {
    return (
      <div>
        <h1>Proposal queue</h1>
        <p className="error">
          You need at least the Ehdottaja (Contributor) role to review proposals.
        </p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div>
        <h1>Proposal queue</h1>
        <p className="error">You don't have permission to review this tenant's proposals.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Proposal queue</h1>

      <label htmlFor="proposal-status">Status filter</label>
      <br />
      <select
        id="proposal-status"
        value={status}
        onChange={(e) => setStatus(e.target.value as StatusFilter)}
      >
        <option value={WAITING_FOR_ME}>waiting for my review</option>
        {STATUSES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: 16 }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Proposals</h2>
            {items.length === 0 ? (
              <p className="muted">
                {status === WAITING_FOR_ME
                  ? 'Nothing is waiting for your review.'
                  : `No proposals with status "${status}".`}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {items.map((proposal) => (
                  <li key={proposal.id}>
                    <button
                      onClick={() => setSelectedId(proposal.id)}
                      style={{ width: '100%', textAlign: 'left' }}
                    >
                      <strong>{proposalTarget(proposal)}</strong>
                      <br />
                      <span className="muted">
                        {PROPOSAL_KIND_LABELS[proposal.kind]} · {proposal.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Review</h2>
            {loadingDetails ? (
              <p className="muted">Loading details…</p>
            ) : !selected ? (
              <p className="muted">Select a proposal to review.</p>
            ) : (
              <>
                <p>
                  <strong>{PROPOSAL_KIND_LABELS[selected.kind]}:</strong> {proposalTarget(selected)}
                  <br />
                  <strong>Status:</strong> {selected.status}
                  <br />
                  <strong>Correlation:</strong> {selected.correlationId}
                  {selected.reviewItemId && (
                    <>
                      <br />
                      <strong>From review item:</strong> {selected.reviewItemId}
                    </>
                  )}
                </p>
                {tenantId && selected.status === 'approved' && selected.manualPublish && (
                  <ManualPublishPanel
                    key={selected.id}
                    tenantId={tenantId}
                    proposalId={selected.id}
                    sheet={selected.manualPublish}
                    publishedInPtv={selected.publishedInPtv}
                    canConfirm={canResolve}
                    onConfirmed={(updated) => {
                      setSelected(updated);
                      void loadList();
                    }}
                  />
                )}
                <DiffView diff={selected.diff} />
                {selected.proposed && selected.kind !== 'connection_update' && (
                  <ProposalPreview key={selected.id} entity={selected.proposed} />
                )}
                {selected.quality && (
                  <>
                    <h3>Automated checks</h3>
                    <QualityFindings findings={selected.quality.findings} />
                  </>
                )}
                {tenantId && (
                  <ProposalReviewers
                    key={selected.id}
                    tenantId={tenantId}
                    proposal={selected}
                    canResolve={canResolve}
                    onChanged={loadSelected}
                  />
                )}
                {tenantId && (
                  <ProposalComments
                    key={selected.id}
                    tenantId={tenantId}
                    proposalId={selected.id}
                    comments={selected.comments ?? []}
                    onAdded={loadSelected}
                  />
                )}
                {selected.status === 'pending' && canResolve && (
                  <p style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="primary"
                      disabled={resolvingAction !== null}
                      onClick={() => void resolve('approve_and_export')}
                    >
                      {resolvingAction === 'approve_and_export' ? 'Resolving…' : 'Approve + export'}
                    </button>
                    {canApply && (
                      <button
                        className="primary"
                        disabled={resolvingAction !== null}
                        onClick={() => void resolve('approve_and_apply')}
                      >
                        {resolvingAction === 'approve_and_apply' ? 'Resolving…' : 'Approve + apply'}
                      </button>
                    )}
                    <button
                      disabled={resolvingAction !== null}
                      onClick={() => void resolve('reject')}
                    >
                      {resolvingAction === 'reject' ? 'Resolving…' : 'Reject'}
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function proposalTarget(proposal: ProposalSummary): string {
  return proposal.serviceId || '(not created yet)';
}

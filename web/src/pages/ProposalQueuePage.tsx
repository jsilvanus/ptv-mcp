import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, apiFetch } from '../api/client';
import type {
  ProposalDetails,
  ProposalKind,
  ProposalResolveAction,
  ProposalStatus,
  ProposalSummary,
} from '../api/types';
import { useTenants } from '../tenants/TenantContext';
import { DiffView } from './DiffView';
import { ProposalComments } from './ProposalComments';
import { ProposalReviewers } from './ProposalReviewers';
import { ProposalPreview } from './ProposalPreview';
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
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Contributors view proposals; resolving needs Approver, applying Publisher.
  const canReview = useMemo(() => roleAtLeast(currentTenant?.role, 'contributor'), [currentTenant]);
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
      } else if (
        !selectedIdRef.current ||
        !list.some((proposal) => proposal.id === selectedIdRef.current)
      ) {
        setSelectedId(list[0]?.id ?? null);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load proposal queue.');
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
        setError(err instanceof ApiError ? err.message : 'Could not load proposal details.');
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
      setError(err instanceof ApiError ? err.message : 'Could not resolve proposal.');
    } finally {
      setResolvingAction(null);
    }
  }

  if (!canReview) {
    return (
      <div>
        <h1>Proposal queue</h1>
        <p className="error">You need at least Editor role to review proposals.</p>
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
                        {KIND_LABELS[proposal.kind]} · {proposal.status}
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
                  <strong>{KIND_LABELS[selected.kind]}:</strong> {proposalTarget(selected)}
                  <br />
                  <strong>Status:</strong> {selected.status}
                  <br />
                  <strong>Correlation:</strong> {selected.correlationId}
                </p>
                <DiffView diff={selected.diff} />
                {selected.proposed && (
                  <ProposalPreview key={selected.id} entity={selected.proposed} />
                )}
                {tenantId && (
                  <ProposalReviewers
                    tenantId={tenantId}
                    proposal={selected}
                    canResolve={canResolve}
                    onChanged={loadSelected}
                  />
                )}
                {tenantId && (
                  <ProposalComments
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

const KIND_LABELS: Record<ProposalKind, string> = {
  service_update: 'Service update',
  service_create: 'New service',
  channel_update: 'Channel update',
};

function proposalTarget(proposal: ProposalSummary): string {
  return proposal.serviceId || '(not created yet)';
}

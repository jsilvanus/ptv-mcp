import { useMemo, useState } from 'react';
import { apiFetch } from '../../api/client';
import type {
  ReviewCampaignDetails,
  ReviewCandidate,
  ReviewItemStatus,
  ReviewTargetKind,
} from '../../api/types';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { ItemTable } from './ItemTable';
import { KIND_LABELS, STATUS_LABELS } from './labels';

/**
 * One campaign: its progress and filterable items, and for Publishers of an
 * open campaign, assigning reviewers and closing it.
 */
export function CampaignPanel({
  tenantId,
  campaign,
  candidates,
  canManage,
  onChanged,
  selectedItemId,
  onSelectItem,
}: {
  tenantId: string;
  campaign: ReviewCampaignDetails;
  candidates: ReviewCandidate[];
  canManage: boolean;
  /** Refreshes the page after a successful action. */
  onChanged(): Promise<void>;
  selectedItemId: string | null;
  onSelectItem(id: string): void;
}) {
  const [status, setStatus] = useState<ReviewItemStatus | ''>('');
  const [kind, setKind] = useState<ReviewTargetKind | ''>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewer, setReviewer] = useState('');
  const { busy, error, run } = useAsyncAction();
  const open = campaign.status === 'open';

  const items = useMemo(
    () =>
      campaign.items.filter(
        (item) => (!status || item.status === status) && (!kind || item.targetKind === kind),
      ),
    [campaign.items, status, kind],
  );

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function assign(body: object): void {
    void run(async () => {
      await apiFetch(`/tenants/${tenantId}/review-campaigns/${campaign.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ reviewer, ...body }),
      });
      setSelected(new Set());
      await onChanged();
    }, 'Could not assign the items.');
  }

  function close(): void {
    if (!window.confirm(`Close "${campaign.name}"? Its items stay as the record.`)) return;
    void run(async () => {
      await apiFetch(`/tenants/${tenantId}/review-campaigns/${campaign.id}/close`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await onChanged();
    }, 'Could not close the campaign.');
  }

  const { progress } = campaign;
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>{campaign.name}</h2>
      <p>
        {campaign.environment} · {campaign.status}
        {campaign.dueDate && ` · due ${campaign.dueDate}`} · started by{' '}
        {campaign.createdByName ?? campaign.createdByUserId}
        <br />
        {progress.total} items: {progress.open} to check, {progress.confirmed} confirmed,{' '}
        {progress.changesProposed} with changes proposed, {progress.unassigned} unassigned
      </p>
      {error && <p className="error">{error}</p>}

      {canManage && open && (
        <div className="card" style={{ marginBottom: 16 }}>
          <label htmlFor="assign-reviewer">Reviewer</label>
          <br />
          <select
            id="assign-reviewer"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          >
            <option value="">Choose a reviewer…</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name} &lt;{c.email}&gt;
              </option>
            ))}
          </select>
          <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              disabled={busy || !reviewer || selected.size === 0}
              onClick={() => assign({ itemIds: [...selected] })}
            >
              Assign selected ({selected.size})
            </button>
            {(['service', 'channel', 'organisation'] as ReviewTargetKind[]).map((k) => (
              <button
                key={k}
                disabled={busy || !reviewer}
                onClick={() => assign({ targetKind: k })}
              >
                Assign unassigned {KIND_LABELS[k].toLowerCase()}s
              </button>
            ))}
          </p>
        </div>
      )}

      <p style={{ display: 'flex', gap: 16 }}>
        <span>
          <label htmlFor="item-status">Status</label>{' '}
          <select
            id="item-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as ReviewItemStatus | '')}
          >
            <option value="">all</option>
            {(Object.keys(STATUS_LABELS) as ReviewItemStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </span>
        <span>
          <label htmlFor="item-kind">Kind</label>{' '}
          <select
            id="item-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ReviewTargetKind | '')}
          >
            <option value="">all</option>
            {(Object.keys(KIND_LABELS) as ReviewTargetKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </span>
      </p>

      <ItemTable
        items={items}
        selectedId={selectedItemId}
        onSelect={onSelectItem}
        {...(canManage && open ? { selectable: { selected, toggle } } : {})}
      />

      {canManage && open && (
        <p>
          <button disabled={busy} onClick={close}>
            Close campaign
          </button>
        </p>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, apiFetch } from '../api/client';
import type {
  PreviewEntity,
  PtvEnvironment,
  QualityReport,
  ReviewCampaignDetails,
  ReviewCampaignSummary,
  ReviewCandidate,
  ReviewItem,
  ReviewItemStatus,
  ReviewTargetKind,
} from '../api/types';
import { roleAtLeast } from '../auth/roles';
import { useTenants } from '../tenants/TenantContext';
import { ProposalPreview } from './ProposalPreview';
import { QualityFindings } from './QualityFindings';
import { MyTasksPanel } from './MyTasksPanel';

const STATUS_LABELS: Record<ReviewItemStatus, string> = {
  open: 'To check',
  confirmed: 'Confirmed',
  changes_proposed: 'Changes proposed',
};

const KIND_LABELS: Record<ReviewTargetKind, string> = {
  organisation: 'Organisation',
  service: 'Service',
  channel: 'Channel',
};

interface ReviewItemDetails extends ReviewItem {
  current: PreviewEntity | null;
  quality: QualityReport | null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function counts(item: ReviewItem): string {
  const errors = item.findings.filter((f) => f.severity === 'error').length;
  const warnings = item.findings.length - errors;
  if (item.findings.length === 0) return '–';
  return `${errors} errors, ${warnings} warnings`;
}

/**
 * Content review campaigns (docs/review-campaigns-plan.md): Publishers
 * start a full check of the organisation's PTV content and assign items;
 * reviewers confirm each item or send it on with proposals drafted through
 * the MCP (reviewItemId); Publishers resolve those in the proposal queue.
 */
export function ReviewCampaignsPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { currentTenant } = useTenants();
  const canView = roleAtLeast(currentTenant?.role, 'contributor');
  const canManage = roleAtLeast(currentTenant?.role, 'publisher');

  const [campaigns, setCampaigns] = useState<ReviewCampaignSummary[]>([]);
  const [myItems, setMyItems] = useState<ReviewItem[]>([]);
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<ReviewCampaignDetails | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [item, setItem] = useState<ReviewItemDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !canView) return;
    setError(null);
    try {
      const [list, mine, members] = await Promise.all([
        apiFetch<ReviewCampaignSummary[]>(`/tenants/${tenantId}/review-campaigns`),
        apiFetch<ReviewItem[]>(`/tenants/${tenantId}/review-items/mine`),
        apiFetch<ReviewCandidate[]>(`/tenants/${tenantId}/review-candidates`),
      ]);
      setCampaigns(list);
      setMyItems(mine);
      setCandidates(members);
      setCampaignId((current) => current ?? list.find((c) => c.status === 'open')?.id ?? null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load review campaigns.'));
    }
  }, [tenantId, canView]);

  const loadCampaign = useCallback(async () => {
    if (!tenantId || !campaignId) {
      setCampaign(null);
      return;
    }
    try {
      setCampaign(
        await apiFetch<ReviewCampaignDetails>(
          `/tenants/${tenantId}/review-campaigns/${campaignId}`,
        ),
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not load the campaign.'));
    }
  }, [tenantId, campaignId]);

  const loadItem = useCallback(async () => {
    if (!tenantId || !itemId) {
      setItem(null);
      return;
    }
    try {
      setItem(await apiFetch<ReviewItemDetails>(`/tenants/${tenantId}/review-items/${itemId}`));
    } catch (err) {
      setError(errorMessage(err, 'Could not load the review item.'));
    }
  }, [tenantId, itemId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadCampaign();
  }, [loadCampaign]);
  useEffect(() => {
    void loadItem();
  }, [loadItem]);

  async function run(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([load(), loadCampaign(), loadItem()]);
      return true;
    } catch (err) {
      setError(errorMessage(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <div>
        <h1>Content review</h1>
        <p className="error">You need at least the Ehdottaja (Contributor) role.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Content review</h1>
      <p className="muted">
        A review campaign checks all of the organisation's PTV content. Reviewers confirm that each
        service, channel and organisation is up to date and has the proper channels linked, or
        propose changes; Publishers publish them from the proposal queue.
      </p>
      {error && <p className="error">{error}</p>}

      {tenantId && <MyTasksPanel tenantId={tenantId} />}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>My review items</h2>
        {myItems.length === 0 ? (
          <p className="muted">Nothing is waiting for your review.</p>
        ) : (
          <ItemTable items={myItems} selectedId={itemId} onSelect={setItemId} />
        )}
      </section>

      {item && tenantId && (
        <ItemPanel
          key={`${item.id}-${item.status}`}
          tenantId={tenantId}
          item={item}
          canManage={canManage}
          busy={busy}
          run={run}
          onClose={() => setItemId(null)}
        />
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Campaigns</h2>
        {campaigns.length === 0 ? (
          <p className="muted">No review campaigns yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Environment</th>
                <th>Status</th>
                <th>Due</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button onClick={() => setCampaignId(c.id)} disabled={c.id === campaignId}>
                      {c.name}
                    </button>
                  </td>
                  <td>{c.environment}</td>
                  <td>{c.status}</td>
                  <td>{c.dueDate ?? '–'}</td>
                  <td>
                    {c.progress.confirmed + c.progress.changesProposed}/{c.progress.total} checked
                    {c.progress.unassigned > 0 && `, ${c.progress.unassigned} unassigned`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && tenantId && (
          <StartCampaignForm
            busy={busy}
            onStart={(body) =>
              run(async () => {
                const created = await apiFetch<ReviewCampaignSummary>(
                  `/tenants/${tenantId}/review-campaigns`,
                  { method: 'POST', body: JSON.stringify(body) },
                );
                setCampaignId(created.id);
              }, 'Could not start the campaign.')
            }
          />
        )}
      </section>

      {campaign && tenantId && (
        <CampaignPanel
          tenantId={tenantId}
          campaign={campaign}
          candidates={candidates}
          canManage={canManage}
          busy={busy}
          run={run}
          selectedItemId={itemId}
          onSelectItem={setItemId}
        />
      )}
    </div>
  );
}

function ItemTable({
  items,
  selectedId,
  onSelect,
  selectable,
}: {
  items: ReviewItem[];
  selectedId: string | null;
  onSelect(id: string): void;
  selectable?: { selected: Set<string>; toggle(id: string): void };
}) {
  return (
    <table>
      <thead>
        <tr>
          {selectable && <th />}
          <th>Content</th>
          <th>Kind</th>
          <th>Reviewer</th>
          <th>Status</th>
          <th>Automated checks</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            {selectable && (
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.targetName}`}
                  checked={selectable.selected.has(item.id)}
                  onChange={() => selectable.toggle(item.id)}
                />
              </td>
            )}
            <td>
              <button onClick={() => onSelect(item.id)} disabled={item.id === selectedId}>
                {item.targetName}
              </button>
            </td>
            <td>
              {KIND_LABELS[item.targetKind]}
              {item.channelType ? ` (${item.channelType})` : ''}
            </td>
            <td>{item.assigneeName ?? <span className="muted">unassigned</span>}</td>
            <td>
              {STATUS_LABELS[item.status]}
              {item.proposals.length > 0 && ` · ${item.proposals.length} proposal(s)`}
            </td>
            <td>{counts(item)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemPanel({
  tenantId,
  item,
  canManage,
  busy,
  run,
  onClose,
}: {
  tenantId: string;
  item: ReviewItemDetails;
  canManage: boolean;
  busy: boolean;
  run(action: () => Promise<unknown>, fallback: string): Promise<boolean>;
  onClose(): void;
}) {
  const [note, setNote] = useState(item.note ?? '');
  const post = (path: string, body: object) =>
    apiFetch(`/tenants/${tenantId}/review-items/${item.id}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
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
              {p.kind} · {p.status} · <code>{p.id}</code>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <AttachProposalForm
          busy={busy}
          onAttach={(proposalId) =>
            run(() => post('attach', { proposalId }), 'Could not attach the proposal.')
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
                void run(
                  () => post('complete', { decision: 'confirmed', note }),
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
                void run(
                  () => post('complete', { decision: 'changes_proposed', note }),
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
            onClick={() =>
              void run(() => post('reopen', { note }), 'Could not send the item back.')
            }
          >
            Send back to reviewer
          </button>
        )}
        <button onClick={onClose}>Close</button>
      </p>
    </section>
  );
}

function StartCampaignForm({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart(body: {
    name: string;
    organizationId: string;
    environment: PtvEnvironment;
    dueDate?: string;
    includeSubOrganisations: boolean;
  }): Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [environment, setEnvironment] = useState<PtvEnvironment>('production');
  const [dueDate, setDueDate] = useState('');
  const [includeSub, setIncludeSub] = useState(true);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const ok = await onStart({
      name,
      organizationId: organizationId.trim(),
      environment,
      ...(dueDate ? { dueDate } : {}),
      includeSubOrganisations: includeSub,
    });
    if (ok) {
      setName('');
      setDueDate('');
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ marginTop: 16 }}>
      <h3>Start a campaign</h3>
      <p className="muted">
        Reads every published service and channel of the organisation from PTV and runs the
        automated checks. This can take a while for large organisations.
      </p>
      <label htmlFor="campaign-name">Name</label>
      <input
        id="campaign-name"
        required
        value={name}
        placeholder="Syksyn 2026 tarkistus"
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="campaign-org">PTV organisation id</label>
      <input
        id="campaign-org"
        required
        value={organizationId}
        onChange={(e) => setOrganizationId(e.target.value)}
      />
      <label htmlFor="campaign-env">Environment</label>
      <select
        id="campaign-env"
        value={environment}
        onChange={(e) => setEnvironment(e.target.value as PtvEnvironment)}
      >
        <option value="production">production</option>
        <option value="test">test</option>
      </select>
      <label htmlFor="campaign-due">Due date (optional)</label>
      <input
        id="campaign-due"
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
      />
      <label>
        <input
          type="checkbox"
          checked={includeSub}
          onChange={(e) => setIncludeSub(e.target.checked)}
        />{' '}
        Include sub-organisations
      </label>
      <p>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Start campaign'}
        </button>
      </p>
    </form>
  );
}

function CampaignPanel({
  tenantId,
  campaign,
  candidates,
  canManage,
  busy,
  run,
  selectedItemId,
  onSelectItem,
}: {
  tenantId: string;
  campaign: ReviewCampaignDetails;
  candidates: ReviewCandidate[];
  canManage: boolean;
  busy: boolean;
  run(action: () => Promise<unknown>, fallback: string): Promise<boolean>;
  selectedItemId: string | null;
  onSelectItem(id: string): void;
}) {
  const [status, setStatus] = useState<ReviewItemStatus | ''>('');
  const [kind, setKind] = useState<ReviewTargetKind | ''>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewer, setReviewer] = useState('');
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
    }, 'Could not assign the items.');
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
          <button
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Close "${campaign.name}"? Its items stay as the record.`)) {
                void run(
                  () =>
                    apiFetch(`/tenants/${tenantId}/review-campaigns/${campaign.id}/close`, {
                      method: 'POST',
                      body: JSON.stringify({}),
                    }),
                  'Could not close the campaign.',
                );
              }
            }}
          >
            Close campaign
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * A Publisher attaches a draft proposal (made in the MCP) to the item: the
 * item reopens and its reviewer becomes a required reviewer of the draft.
 */
function AttachProposalForm({
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

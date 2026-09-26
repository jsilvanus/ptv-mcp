import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch, errorMessage } from '../api/client';
import type {
  ReviewCampaignDetails,
  ReviewCampaignSummary,
  ReviewCandidate,
  ReviewItem,
} from '../api/types';
import { roleAtLeast } from '../auth/roles';
import { useTenants } from '../tenants/TenantContext';
import { MyTasksPanel } from './MyTasksPanel';
import { ContentExportPanel } from './ContentExportPanel';
import { CampaignList } from './reviews/CampaignList';
import { CampaignPanel } from './reviews/CampaignPanel';
import { ItemPanel } from './reviews/ItemPanel';
import { ItemTable } from './reviews/ItemTable';
import type { ReviewItemDetails } from './reviews/labels';
import { StartCampaignForm } from './reviews/StartCampaignForm';

/**
 * Content review campaigns (docs/review-campaigns-plan.md): Publishers
 * start a full check of the organisation's PTV content and assign items;
 * reviewers confirm each item or send it on with proposals drafted through
 * the MCP (reviewItemId); Publishers resolve those in the proposal queue.
 *
 * The page loads the data; the panels in ./reviews run their own actions
 * (each with its own busy/error state) and call `refresh` afterwards.
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

  const load = useCallback(async () => {
    if (!tenantId || !canView) return;
    setError(null);
    try {
      const [list, mine] = await Promise.all([
        apiFetch<ReviewCampaignSummary[]>(`/tenants/${tenantId}/review-campaigns`),
        apiFetch<ReviewItem[]>(`/tenants/${tenantId}/review-items/mine`),
      ]);
      setCampaigns(list);
      setMyItems(mine);
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
  // The reviewer candidates only change with the tenant's members, so they
  // are not refetched after every action like the rest.
  useEffect(() => {
    if (!tenantId || !canView) return;
    apiFetch<ReviewCandidate[]>(`/tenants/${tenantId}/review-candidates`)
      .then(setCandidates)
      .catch((err: unknown) => setError(errorMessage(err, 'Could not load the reviewers.')));
  }, [tenantId, canView]);
  useEffect(() => {
    void loadCampaign();
  }, [loadCampaign]);
  useEffect(() => {
    void loadItem();
  }, [loadItem]);

  /** Reloads everything an action can change. The loaders report their own errors. */
  const refresh = useCallback(async () => {
    await Promise.all([load(), loadCampaign(), loadItem()]);
  }, [load, loadCampaign, loadItem]);

  /**
   * After starting a campaign: select it (the campaignId effect then loads
   * it, so it is not reloaded here) and refresh the rest.
   */
  const handleStarted = useCallback(
    async (createdId: string) => {
      setCampaignId(createdId);
      await Promise.all([load(), loadItem()]);
    },
    [load, loadItem],
  );

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
          onChanged={refresh}
          onClose={() => setItemId(null)}
        />
      )}

      <CampaignList campaigns={campaigns} selectedId={campaignId} onSelect={setCampaignId}>
        {canManage && tenantId && (
          <StartCampaignForm tenantId={tenantId} onStarted={handleStarted} />
        )}
      </CampaignList>

      {tenantId && <ContentExportPanel tenantId={tenantId} />}

      {campaign && tenantId && (
        <CampaignPanel
          tenantId={tenantId}
          campaign={campaign}
          candidates={candidates}
          canManage={canManage}
          onChanged={refresh}
          selectedItemId={itemId}
          onSelectItem={setItemId}
        />
      )}
    </div>
  );
}

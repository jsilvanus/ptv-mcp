import { useState, type FormEvent } from 'react';
import { apiFetch } from '../../api/client';
import type { PtvEnvironment, ReviewCampaignSummary } from '../../api/types';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { useAsyncAction } from '../../hooks/useAsyncAction';

/** Publishers start a campaign over one organisation's published content. */
export function StartCampaignForm({
  tenantId,
  onStarted,
}: {
  tenantId: string;
  /** Selects the new campaign and refreshes the page. */
  onStarted(campaignId: string): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [environment, setEnvironment] = useState<PtvEnvironment>('production');
  const [dueDate, setDueDate] = useState('');
  const [includeSub, setIncludeSub] = useState(true);
  const { busy, error, run } = useAsyncAction();

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const ok = await run(async () => {
      const created = await apiFetch<ReviewCampaignSummary>(
        `/tenants/${tenantId}/review-campaigns`,
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            organizationId: organizationId.trim(),
            environment,
            ...(dueDate ? { dueDate } : {}),
            includeSubOrganisations: includeSub,
          }),
        },
      );
      await onStarted(created.id);
    }, 'Could not start the campaign.');
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
      <EnvironmentSelect id="campaign-env" value={environment} onChange={setEnvironment} />
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
      {error && <p className="error">{error}</p>}
    </form>
  );
}

import type { ReactNode } from 'react';
import type { ReviewCampaignSummary } from '../../api/types';

/** The tenant's campaigns with their progress; `children` go below the table. */
export function CampaignList({
  campaigns,
  selectedId,
  onSelect,
  children,
}: {
  campaigns: ReviewCampaignSummary[];
  selectedId: string | null;
  onSelect(id: string): void;
  children?: ReactNode;
}) {
  return (
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
                  <button onClick={() => onSelect(c.id)} disabled={c.id === selectedId}>
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
      {children}
    </section>
  );
}

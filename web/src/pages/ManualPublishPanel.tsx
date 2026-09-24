import { useState } from 'react';
import { ApiError, apiFetch } from '../api/client';
import type { ManualPublishSheet, ProposalDetails } from '../api/types';

/**
 * The manual-publishing sheet of an approved (exported) proposal: every
 * field to enter in PTV's own UI, with copy buttons, and "Mark as
 * published", which has the server check PTV before closing the proposal.
 */
export function ManualPublishPanel({
  tenantId,
  proposalId,
  sheet,
  publishedInPtv,
  canConfirm,
  onConfirmed,
}: {
  tenantId: string;
  proposalId: string;
  sheet: ManualPublishSheet;
  publishedInPtv: boolean | null;
  canConfirm: boolean;
  onConfirmed: (updated: ProposalDetails) => void;
}) {
  const [ptvId, setPtvId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  async function copy(index: number, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(index);
    } catch {
      setCopied(null);
    }
  }

  async function confirm(): Promise<void> {
    setConfirming(true);
    setError(null);
    try {
      const updated = await apiFetch<ProposalDetails>(
        `/tenants/${tenantId}/proposals/${proposalId}/confirm-published`,
        {
          method: 'POST',
          body: JSON.stringify(sheet.action === 'create' ? { ptvId: ptvId.trim() } : {}),
        },
      );
      onConfirmed(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm the publishing.');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section>
      <h3>Manual publishing in PTV</h3>
      <p>
        <strong>{sheet.target}</strong>
        {sheet.name ? `: ${sheet.name}` : ''}
        {sheet.ptvId ? <span className="muted"> ({sheet.ptvId})</span> : null}
      </p>
      {publishedInPtv && (
        <p>PTV already has every change in this proposal. Mark it as published.</p>
      )}
      <ol>
        {sheet.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {sheet.fields.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>PTV field</th>
              <th>Now</th>
              <th>Enter</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sheet.fields.map((field, index) => (
              <tr key={`${field.field}-${field.language ?? ''}-${index}`}>
                <td>
                  {field.label}
                  {field.language ? ` (${field.language})` : ''}
                </td>
                <td className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                  {field.before ?? ''}
                </td>
                <td style={{ whiteSpace: 'pre-wrap' }}>{field.after}</td>
                <td>
                  <button type="button" onClick={() => void copy(index, field.after)}>
                    {copied === index ? 'Copied' : 'Copy'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canConfirm && (
        <p style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {sheet.action === 'create' && (
            <>
              <label htmlFor="manual-publish-ptv-id">Id of the new item in PTV</label>
              <input
                id="manual-publish-ptv-id"
                value={ptvId}
                onChange={(e) => setPtvId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </>
          )}
          <button
            className="primary"
            disabled={confirming || (sheet.action === 'create' && !ptvId.trim())}
            onClick={() => void confirm()}
          >
            {confirming ? 'Checking PTV…' : 'Mark as published'}
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

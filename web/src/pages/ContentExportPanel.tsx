import { useState, type FormEvent } from 'react';
import { ApiError, apiDownload } from '../api/client';
import type { PtvEnvironment } from '../api/types';

/**
 * Downloads an organisation's PTV content with the automated check
 * findings as an Excel file: the content report DVV reviews before it
 * issues IN-API production credentials.
 */
export function ContentExportPanel({ tenantId }: { tenantId: string }) {
  const [organizationId, setOrganizationId] = useState('');
  const [environment, setEnvironment] = useState<PtvEnvironment>('test');
  const [includeSub, setIncludeSub] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        organizationId: organizationId.trim(),
        environment,
        includeSubOrganisations: String(includeSub),
      });
      const { blob, filename } = await apiDownload(
        `/tenants/${tenantId}/ptv/content-export?${params.toString()}`,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename ?? 'ptv-sisalto.xlsx';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export the content.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Content report (Excel)</h2>
      <p className="muted">
        The organisation's organisations, services, channels and connections as PTV has them, with
        the automated check findings. DVV reviews this report before it issues IN-API production
        credentials.
      </p>
      {error && <p className="error">{error}</p>}
      <form onSubmit={(e) => void download(e)}>
        <label htmlFor="export-org">PTV organisation id</label>
        <input
          id="export-org"
          required
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
        />
        <label htmlFor="export-env">Environment</label>
        <select
          id="export-env"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value as PtvEnvironment)}
        >
          <option value="test">test</option>
          <option value="production">production</option>
        </select>
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
            {busy ? 'Reading PTV…' : 'Download report'}
          </button>
        </p>
      </form>
    </section>
  );
}

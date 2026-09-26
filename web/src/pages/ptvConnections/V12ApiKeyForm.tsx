import { useState } from 'react';
import { apiFetch, errorMessage } from '../../api/client';
import type { PtvEnvironment, PtvV12ConnectionStatus, TenantMembership } from '../../api/types';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { FormStatus, type FormStatusValue } from './FormStatus';

/** Saves and tests the tenant's PTV v12 API key (read access). */
export function V12ApiKeyForm({
  tenant,
  onSaved,
}: {
  tenant: TenantMembership | null;
  /** Receives the tenant's v12 connections after a successful save. */
  onSaved(connections: PtvV12ConnectionStatus[]): void;
}) {
  const [environment, setEnvironment] = useState<PtvEnvironment>('production');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<FormStatusValue | null>(null);

  async function saveAndTest(): Promise<void> {
    if (!tenant || !apiKey.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      await apiFetch<void>(`/tenants/${tenant.tenantId}/ptv/v12`, {
        method: 'PUT',
        body: JSON.stringify({ environment, apiKey }),
      });
      await apiFetch<{ ok: boolean; environment: string; apiVersion: string }>(
        `/tenants/${tenant.tenantId}/ptv/v12/${environment}/test`,
        { method: 'POST' },
      );
      onSaved(await apiFetch<PtvV12ConnectionStatus[]>(`/tenants/${tenant.tenantId}/ptv/v12`));
      setApiKey('');
      setStatus({ ok: true, message: `Connected to PTV v12 (${environment}).` });
    } catch (err) {
      setStatus({ ok: false, message: errorMessage(err, 'PTV v12 connection test failed.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 style={{ marginTop: 32 }}>Connect a PTV v12 API key</h2>
      <p className="muted">
        The v12 API key is stored encrypted and belongs to the selected tenant. It is used for read
        access to PTV.
      </p>
      {tenant ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{tenant.tenantName}</strong>
          <EnvironmentSelect value={environment} onChange={setEnvironment} />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="PTV v12 API key"
            autoComplete="off"
            style={{ minWidth: 320 }}
          />
          <button
            className="primary"
            onClick={() => void saveAndTest()}
            disabled={busy || !apiKey.trim()}
          >
            {busy ? 'Testing…' : 'Save & test'}
          </button>
        </div>
      ) : (
        <p className="muted">Select a tenant first.</p>
      )}
      <FormStatus status={status} />
    </>
  );
}

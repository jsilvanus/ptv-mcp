import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../api/client';
import type { ConnectionStatus, PtvEnvironment, PtvV12ConnectionStatus } from '../api/types';
import { useTenants } from '../tenants/TenantContext';

export const PTV_CONNECT_ENVIRONMENT_KEY = 'ptv_connect_environment';

const ENVIRONMENTS: PtvEnvironment[] = ['test', 'production'];

export function PtvConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [v12Connections, setV12Connections] = useState<PtvV12ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingEnv, setConnectingEnv] = useState<PtvEnvironment | null>(null);
  const [disconnectingEnv, setDisconnectingEnv] = useState<PtvEnvironment | null>(null);
  const { currentTenant } = useTenants();
  const [v12Environment, setV12Environment] = useState<PtvEnvironment>('production');
  const [v12ApiKey, setV12ApiKey] = useState('');
  const [v12Busy, setV12Busy] = useState(false);
  const [v12Status, setV12Status] = useState<string | null>(null);

  async function loadConnections(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<ConnectionStatus[]>('/ptv-connections');
      setConnections(result);
      if (currentTenant) {
        try {
          const v12 = await apiFetch<PtvV12ConnectionStatus[]>(
            `/tenants/${currentTenant.tenantId}/ptv/v12`,
          );
          setV12Connections(v12);
        } catch (err) {
          // v12 configuration is tenant-admin only; don't let it hide
          // the user's v11 connections when the current tenant is not admin.
          if (err instanceof ApiError && err.status !== 403) {
            throw err;
          }
          setV12Connections([]);
        }
      } else {
        setV12Connections([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load PTV connections.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadConnections();
  }, [currentTenant?.tenantId]);

  async function handleConnect(environment: PtvEnvironment): Promise<void> {
    setError(null);
    setConnectingEnv(environment);
    try {
      const { url } = await apiFetch<{ url: string; state: string }>(
        `/ptv-connections/v11/authorize-url?environment=${environment}`,
      );
      sessionStorage.setItem(PTV_CONNECT_ENVIRONMENT_KEY, environment);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the PTV connection.');
      setConnectingEnv(null);
    }
  }

  async function handleDisconnect(environment: PtvEnvironment): Promise<void> {
    if (!window.confirm(`Disconnect your PTV ${environment} account? This revokes access.`)) {
      return;
    }
    setError(null);
    setDisconnectingEnv(environment);
    try {
      await apiFetch<void>(`/ptv-connections/v11/${environment}`, { method: 'DELETE' });
      await loadConnections();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disconnect the PTV account.');
    } finally {
      setDisconnectingEnv(null);
    }
  }

  async function saveAndTestV12(): Promise<void> {
    if (!currentTenant || !v12ApiKey.trim()) return;
    setV12Busy(true);
    setV12Status(null);
    setError(null);
    try {
      await apiFetch<void>(`/tenants/${currentTenant.tenantId}/ptv/v12`, {
        method: 'PUT',
        body: JSON.stringify({ environment: v12Environment, apiKey: v12ApiKey }),
      });
      await apiFetch<{ ok: boolean; environment: string; apiVersion: string }>(
        `/tenants/${currentTenant.tenantId}/ptv/v12/${v12Environment}/test`,
        { method: 'POST' },
      );
      const v12 = await apiFetch<PtvV12ConnectionStatus[]>(
        `/tenants/${currentTenant.tenantId}/ptv/v12`,
      );
      setV12Connections(v12);
      setV12ApiKey('');
      setV12Status(`Connected to PTV v12 (${v12Environment}).`);
    } catch (err) {
      setV12Status(err instanceof ApiError ? err.message : 'PTV v12 connection test failed.');
    } finally {
      setV12Busy(false);
    }
  }

  function activeConnectionFor(environment: PtvEnvironment): ConnectionStatus | undefined {
    return connections.find(
      (c) => c.apiVersion === 'v11' && c.environment === environment && !c.revokedAt,
    );
  }

  return (
    <div>
      <h1>PTV connections</h1>
      <p className="muted">
        Connect your PTV account to let this tool make changes on your behalf. Connections are
        per-user and work across every tenant you're a Publisher for.
      </p>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>API version</th>
              <th>Environment</th>
              <th>Status</th>
              <th>Connected</th>
              <th>Token expires</th>
              <th>Last validated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => (
              <tr key={`${c.apiVersion}-${c.environment}`}>
                <td>{c.apiVersion}</td>
                <td>{c.environment}</td>
                <td>{c.revokedAt ? 'Disconnected' : 'Active'}</td>
                <td>{new Date(c.connectedAt).toLocaleString()}</td>
                <td>{c.tokenExpiresAt ? new Date(c.tokenExpiresAt).toLocaleString() : '—'}</td>
                <td>{c.lastValidatedAt ? new Date(c.lastValidatedAt).toLocaleString() : '—'}</td>
                <td>
                  {!c.revokedAt && (
                    <button
                      onClick={() => void handleDisconnect(c.environment)}
                      disabled={disconnectingEnv === c.environment}
                    >
                      {disconnectingEnv === c.environment ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {v12Connections.map((c) => (
              <tr key={`v12-${c.environment}`}>
                <td>{c.apiVersion}</td>
                <td>{c.environment}</td>
                <td>Configured</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>Read access</td>
              </tr>
            ))}
            {connections.length === 0 && v12Connections.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No PTV connections yet — connect one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 32 }}>Connect a PTV v12 API key</h2>
      <p className="muted">
        The v12 API key is stored encrypted and belongs to the selected tenant.
        It is used for read access to PTV.
      </p>
      {currentTenant ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{currentTenant.tenantName}</strong>
          <select value={v12Environment} onChange={(e) => setV12Environment(e.target.value as PtvEnvironment)}>
            <option value="production">production</option>
            <option value="test">test</option>
          </select>
          <input
            type="password"
            value={v12ApiKey}
            onChange={(e) => setV12ApiKey(e.target.value)}
            placeholder="PTV v12 API key"
            autoComplete="off"
            style={{ minWidth: 320 }}
          />
          <button className="primary" onClick={() => void saveAndTestV12()} disabled={v12Busy || !v12ApiKey.trim()}>
            {v12Busy ? 'Testing…' : 'Save & test'}
          </button>
        </div>
      ) : (
        <p className="muted">Select a tenant first.</p>
      )}
      {v12Status && <p className={v12Status.startsWith('Connected') ? 'muted' : 'error'}>{v12Status}</p>}

      <h2 style={{ marginTop: 24 }}>Connect a PTV v11 account</h2>
      <div style={{ display: 'flex', gap: 8 }}>
        {ENVIRONMENTS.map((environment) => {
          const active = activeConnectionFor(environment);
          return (
            <button
              key={environment}
              className="primary"
              onClick={() => void handleConnect(environment)}
              disabled={connectingEnv !== null || !!active}
            >
              {connectingEnv === environment
                ? 'Redirecting…'
                : active
                  ? `${environment} connected`
                  : `Connect ${environment}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

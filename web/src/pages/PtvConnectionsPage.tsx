import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError, errorMessage } from '../api/client';
import type {
  ConnectionStatus,
  PtvEnvironment,
  PtvV11ApiUserStatus,
  PtvV12ConnectionStatus,
} from '../api/types';
import { useTenants } from '../tenants/TenantContext';
import { testOrganisationLabel } from '../ptv/testOrganisations';
import { V11ApiUserForm } from './ptvConnections/V11ApiUserForm';
import { V12ApiKeyForm } from './ptvConnections/V12ApiKeyForm';

export const PTV_CONNECT_ENVIRONMENT_KEY = 'ptv_connect_environment';

const ENVIRONMENTS: PtvEnvironment[] = ['test', 'production'];

interface TenantPtvConfig {
  v12: PtvV12ConnectionStatus[];
  v11ApiUsers: PtvV11ApiUserStatus[];
}

const NO_TENANT_PTV_CONFIG: TenantPtvConfig = { v12: [], v11ApiUsers: [] };

/**
 * The tenant's own PTV credentials (v12 API keys, v11 API users). That
 * configuration is tenant-admin only; a 403 reads as none, so it does not
 * hide the user's own v11 connections when they are not an admin.
 */
async function fetchTenantPtvConfig(tenantId: string): Promise<TenantPtvConfig> {
  try {
    const [v12, v11ApiUsers] = await Promise.all([
      apiFetch<PtvV12ConnectionStatus[]>(`/tenants/${tenantId}/ptv/v12`),
      apiFetch<PtvV11ApiUserStatus[]>(`/tenants/${tenantId}/ptv/v11/api-user`),
    ]);
    return { v12, v11ApiUsers };
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return NO_TENANT_PTV_CONFIG;
    throw err;
  }
}

export function PtvConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [v12Connections, setV12Connections] = useState<PtvV12ConnectionStatus[]>([]);
  const [v11ApiUsers, setV11ApiUsers] = useState<PtvV11ApiUserStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingEnv, setConnectingEnv] = useState<PtvEnvironment | null>(null);
  const [disconnectingEnv, setDisconnectingEnv] = useState<PtvEnvironment | null>(null);
  const { currentTenant } = useTenants();
  const tenantId = currentTenant?.tenantId;

  const loadConnections = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // Both requests run at once; the user's own connections are still
      // shown when only the tenant configuration fails.
      const [own, tenantConfig] = await Promise.allSettled([
        apiFetch<ConnectionStatus[]>('/ptv-connections'),
        tenantId ? fetchTenantPtvConfig(tenantId) : Promise.resolve(NO_TENANT_PTV_CONFIG),
      ]);
      if (own.status === 'rejected') throw own.reason;
      setConnections(own.value);
      if (tenantConfig.status === 'rejected') throw tenantConfig.reason;
      setV12Connections(tenantConfig.value.v12);
      setV11ApiUsers(tenantConfig.value.v11ApiUsers);
    } catch (err) {
      setError(errorMessage(err, 'Could not load PTV connections.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

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
      setError(errorMessage(err, 'Could not start the PTV connection.'));
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
      setError(errorMessage(err, 'Could not disconnect the PTV account.'));
    } finally {
      setDisconnectingEnv(null);
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
            {v11ApiUsers.map((c) => (
              <tr key={`v11-api-${c.environment}`}>
                <td>v11 (API user)</td>
                <td>{c.environment}</td>
                <td>
                  {c.username ?? 'Configured'}
                  {c.organisationId && (
                    <div className="muted">
                      {testOrganisationLabel(c.organisationId) ?? c.organisationId}
                    </div>
                  )}
                </td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>{c.supportsWrite ? 'Read & write' : 'Read access'}</td>
              </tr>
            ))}
            {connections.length === 0 &&
              v12Connections.length === 0 &&
              v11ApiUsers.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No PTV connections yet — connect one below.
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      )}

      <V12ApiKeyForm tenant={currentTenant} onSaved={setV12Connections} />
      <V11ApiUserForm tenant={currentTenant} onSaved={setV11ApiUsers} />

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

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch, ApiError } from '../api/client';
import type { AuditEntry, ServiceDiffEntry } from '../api/types';
import { DiffView } from './DiffView';

function hasDiff(
  entry: AuditEntry,
): entry is AuditEntry & { afterState: { diff: ServiceDiffEntry[] } } {
  return (
    entry.action === 'ProposeServiceChange' &&
    typeof entry.afterState === 'object' &&
    entry.afterState !== null &&
    Array.isArray((entry.afterState as { diff?: unknown }).diff)
  );
}

export function AuditLogPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [resourceType, setResourceType] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const params = new URLSearchParams();
      if (resourceType) params.set('resourceType', resourceType);
      if (correlationId) params.set('correlationId', correlationId);
      const query = params.toString();
      const list = await apiFetch<AuditEntry[]>(
        `/tenants/${tenantId}/audit-entries${query ? `?${query}` : ''}`,
      );
      setEntries(list);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError('Could not load the audit log.');
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId, resourceType, correlationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return <p className="error">You don't have permission to view this tenant's audit log.</p>;
  }

  return (
    <div>
      <h1>Audit log</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        style={{ display: 'flex', gap: 8, marginBottom: 16 }}
      >
        <input
          placeholder="Filter by resource type (e.g. Service)"
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
        />
        <input
          placeholder="Filter by correlation id"
          value={correlationId}
          onChange={(e) => setCorrelationId(e.target.value)}
        />
        <button type="submit">Filter</button>
      </form>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Adapter</th>
              <th>Result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <Fragment key={entry.id}>
                <tr>
                  <td>{new Date(entry.createdAt).toLocaleString()}</td>
                  <td>{entry.action}</td>
                  <td>
                    {entry.resourceType}
                    {entry.resourceId ? ` #${entry.resourceId}` : ''}
                  </td>
                  <td className="muted">
                    {entry.apiVersion ? `${entry.apiVersion} / ${entry.environment}` : '—'}
                  </td>
                  <td>{entry.result}</td>
                  <td>
                    {hasDiff(entry) && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                      >
                        {expandedId === entry.id ? 'Hide diff' : 'View diff'}
                      </button>
                    )}
                  </td>
                </tr>
                {expandedId === entry.id && hasDiff(entry) && (
                  <tr>
                    <td colSpan={6}>
                      <DiffView diff={entry.afterState.diff} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No audit entries match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

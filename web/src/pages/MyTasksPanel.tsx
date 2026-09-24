import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiFetch } from '../api/client';
import type { ChangeReadiness, MyTasks, PtvEnvironment } from '../api/types';

const READINESS_LABELS: Record<ChangeReadiness, string> = {
  ready_to_resolve: 'Ready to approve or reject',
  waiting_for_reviewers: 'Waiting for required reviewers',
  needs_another_resolver: 'Your own: another member resolves it (four-eyes)',
  approved_for_manual_publish: "Approved + exported: publish in PTV's own UI",
};

/**
 * "Waiting for you": the same inbox the MCP's ptv_my_tasks gives the AI
 * assistant (src/mcp/myTasks.ts) — review items, sign-offs, and for
 * Approvers and above every suggested change still to review, resolve or
 * publish.
 */
export function MyTasksPanel({ tenantId }: { tenantId: string }) {
  const [environment, setEnvironment] = useState<PtvEnvironment>('production');
  const [tasks, setTasks] = useState<MyTasks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTasks(await apiFetch<MyTasks>(`/tenants/${tenantId}/my-tasks?environment=${environment}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your tasks.');
    }
  }, [tenantId, environment]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Waiting for you</h2>
      <label htmlFor="tasks-env">Environment</label>{' '}
      <select
        id="tasks-env"
        value={environment}
        onChange={(e) => setEnvironment(e.target.value as PtvEnvironment)}
      >
        <option value="production">production</option>
        <option value="test">test</option>
      </select>{' '}
      <button onClick={() => void load()}>Refresh</button>
      {error && <p className="error">{error}</p>}
      {tasks && (
        <>
          <ul>
            {tasks.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {tasks.changesToHandle.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Suggested change</th>
                  <th>Status</th>
                  <th>Reviewers</th>
                  <th>From review</th>
                </tr>
              </thead>
              <tbody>
                {tasks.changesToHandle.map((change) => (
                  <tr key={change.id}>
                    <td>
                      <Link to={`/tenants/${tenantId}/proposals`}>
                        {change.kind} · {change.serviceId || 'new service'}
                      </Link>
                    </td>
                    <td>{READINESS_LABELS[change.readiness]}</td>
                    <td>
                      {change.reviewers.length === 0
                        ? '–'
                        : change.reviewers.map((r) => `${r.userName}: ${r.decision}`).join(', ')}
                    </td>
                    <td>{change.reviewItemId ? 'yes' : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

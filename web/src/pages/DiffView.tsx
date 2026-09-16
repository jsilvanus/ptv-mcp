import type { ServiceDiffEntry } from '../api/types';

function formatValue(value: unknown): string {
  if (value === undefined) return '(none)';
  if (value === null) return '(null)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Renders the frozen `ServiceDiffEntry[]` contract from
 * src/mcp/proposeChanges.ts — the same shape `ptv_propose_changes`
 * returns and what a `ProposeServiceChange` audit entry's `afterState.diff`
 * holds. One row per changed field (localized fields like `names.fi`
 * already arrive pre-split per language from that contract).
 */
export function DiffView({ diff }: { diff: ServiceDiffEntry[] }) {
  if (diff.length === 0) {
    return <p className="muted">No field changes in this proposal.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {diff.map((entry) => (
          <tr key={entry.field}>
            <td>
              <code>{entry.field}</code>
            </td>
            <td className="muted">{formatValue(entry.before)}</td>
            <td>{formatValue(entry.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

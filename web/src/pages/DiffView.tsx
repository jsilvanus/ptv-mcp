import type { CodeListEntry, ServiceDiffEntry } from '../api/types';
import { CODE_LIST_FIELDS, codeEntryKey, codeEntryLabel, fieldLabel } from './ptvLabels';
import { formatFieldValue } from './fieldFormat';

function isCodeListField(field: string): boolean {
  return (CODE_LIST_FIELDS as readonly string[]).includes(field);
}

/** Removed entries struck through, added ones marked, unchanged ones plain. */
function CodeListChange({ before, after }: { before: unknown; after: unknown }) {
  const oldEntries = Array.isArray(before) ? (before as CodeListEntry[]) : [];
  const newEntries = Array.isArray(after) ? (after as CodeListEntry[]) : [];
  const oldKeys = new Set(oldEntries.map(codeEntryKey));
  const newKeys = new Set(newEntries.map(codeEntryKey));
  const removed = oldEntries.filter((entry) => !newKeys.has(codeEntryKey(entry)));
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {newEntries.map((entry) => (
        <li key={codeEntryKey(entry)} title={entry.uri}>
          {oldKeys.has(codeEntryKey(entry)) ? (
            codeEntryLabel(entry)
          ) : (
            <strong>+ {codeEntryLabel(entry)}</strong>
          )}
        </li>
      ))}
      {removed.map((entry) => (
        <li key={codeEntryKey(entry)} title={entry.uri} className="muted">
          <s>− {codeEntryLabel(entry)}</s>
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders the frozen `ServiceDiffEntry[]` contract from
 * src/mcp/proposeChanges.ts — the same shape `ptv_propose_changes`
 * returns and what a `ProposeServiceChange` audit entry's `afterState.diff`
 * holds. One row per changed field (localized fields like `names.fi`
 * already arrive pre-split per language from that contract);
 * classification lists show what is added and removed.
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
        {diff.map((entry) =>
          isCodeListField(entry.field) ? (
            <tr key={entry.field}>
              <td title={entry.field}>{fieldLabel(entry.field)}</td>
              <td colSpan={2}>
                <CodeListChange before={entry.before} after={entry.after} />
              </td>
            </tr>
          ) : (
            <tr key={entry.field}>
              <td title={entry.field}>{fieldLabel(entry.field)}</td>
              <td className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                {formatFieldValue(entry.field, entry.before)}
              </td>
              <td style={{ whiteSpace: 'pre-wrap' }}>
                {formatFieldValue(entry.field, entry.after)}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

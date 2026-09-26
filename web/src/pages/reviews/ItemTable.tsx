import type { ReviewItem } from '../../api/types';
import { KIND_LABELS, STATUS_LABELS } from './labels';

function counts(item: ReviewItem): string {
  const errors = item.findings.filter((f) => f.severity === 'error').length;
  const warnings = item.findings.length - errors;
  if (item.findings.length === 0) return '–';
  return `${errors} errors, ${warnings} warnings`;
}

/** Review items as a table; `selectable` adds the checkboxes for assigning. */
export function ItemTable({
  items,
  selectedId,
  onSelect,
  selectable,
}: {
  items: ReviewItem[];
  selectedId: string | null;
  onSelect(id: string): void;
  selectable?: { selected: Set<string>; toggle(id: string): void };
}) {
  return (
    <table>
      <thead>
        <tr>
          {selectable && <th />}
          <th>Content</th>
          <th>Kind</th>
          <th>Reviewer</th>
          <th>Status</th>
          <th>Automated checks</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            {selectable && (
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.targetName}`}
                  checked={selectable.selected.has(item.id)}
                  onChange={() => selectable.toggle(item.id)}
                />
              </td>
            )}
            <td>
              <button onClick={() => onSelect(item.id)} disabled={item.id === selectedId}>
                {item.targetName}
              </button>
            </td>
            <td>
              {KIND_LABELS[item.targetKind]}
              {item.channelType ? ` (${item.channelType})` : ''}
            </td>
            <td>{item.assigneeName ?? <span className="muted">unassigned</span>}</td>
            <td>
              {STATUS_LABELS[item.status]}
              {item.proposals.length > 0 && ` · ${item.proposals.length} proposal(s)`}
            </td>
            <td>{counts(item)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

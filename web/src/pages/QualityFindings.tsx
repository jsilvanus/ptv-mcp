import type { QualityFinding } from '../api/types';

/**
 * Automated content check results (src/quality/contentChecks.ts): errors
 * break a DVV rule, warnings are heuristics for a person to judge. Check
 * ids refer to guides/content-quality.md.
 */
export function QualityFindings({ findings }: { findings: QualityFinding[] }) {
  if (findings.length === 0) {
    return <p className="muted">Automated checks found nothing.</p>;
  }
  const sorted = [...findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1,
  );
  return (
    <table>
      <thead>
        <tr>
          <th>Check</th>
          <th>Field</th>
          <th>Finding</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((finding, index) => (
          <tr key={`${finding.checkId}-${finding.field}-${finding.language ?? ''}-${index}`}>
            <td>
              <span className={finding.severity === 'error' ? 'error' : 'muted'}>
                {finding.severity === 'error' ? 'Error' : 'Warning'}
              </span>{' '}
              {finding.checkId}
            </td>
            <td>
              {finding.field}
              {finding.language ? ` (${finding.language})` : ''}
            </td>
            <td>
              {finding.message}
              {finding.excerpt && (
                <>
                  <br />
                  <span className="muted">“{finding.excerpt}”</span>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

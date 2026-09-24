import { useState } from 'react';
import type { PreviewEntity } from '../api/types';
import { ChannelDetails } from './ChannelDetails';
import {
  CODE_LIST_FIELDS,
  codeEntryKey,
  codeEntryLabel,
  FIELD_LABELS,
  languageLabel,
} from './ptvLabels';

/**
 * How the service or channel reads after approval, one language at a
 * time — the same text an Approver would copy into PTV on
 * approve_and_export, and the only readable view of a new service.
 */
export function ProposalPreview({
  entity,
  title = 'Preview after approval',
}: {
  entity: PreviewEntity;
  title?: string;
}) {
  const languages = [
    ...new Set([
      ...(entity.languages ?? []),
      ...Object.keys(entity.names ?? {}),
      ...Object.keys(entity.descriptions ?? {}),
    ]),
  ];
  const [language, setLanguage] = useState(languages[0] ?? 'fi');
  const text = (field: 'names' | 'summaries' | 'descriptions') => entity[field]?.[language];

  return (
    <section>
      <h3>{title}</h3>
      {languages.length > 1 && (
        <p style={{ display: 'flex', gap: 8 }}>
          {languages.map((code) => (
            <button
              key={code}
              className={code === language ? 'primary' : undefined}
              onClick={() => setLanguage(code)}
            >
              {languageLabel(code)}
            </button>
          ))}
        </p>
      )}
      <h4 style={{ marginBottom: 4 }}>
        {text('names') ?? <span className="muted">(ei nimeä)</span>}
      </h4>
      {text('summaries') && <p style={{ fontStyle: 'italic' }}>{text('summaries')}</p>}
      {text('descriptions') && <p style={{ whiteSpace: 'pre-wrap' }}>{text('descriptions')}</p>}
      <ChannelDetails entity={entity} language={language} />
      {CODE_LIST_FIELDS.filter((field) => (entity[field]?.length ?? 0) > 0).map((field) => (
        <div key={field}>
          <strong>{FIELD_LABELS[field]}</strong>
          <ul style={{ marginTop: 4 }}>
            {entity[field]!.map((entry) => (
              <li key={codeEntryKey(entry)} title={entry.uri}>
                {codeEntryLabel(entry)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

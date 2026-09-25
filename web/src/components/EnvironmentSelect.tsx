import { ENVIRONMENTS, type PtvEnvironment } from '../api/types';

/** A select of the PTV environments. */
export function EnvironmentSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: PtvEnvironment;
  onChange(environment: PtvEnvironment): void;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as PtvEnvironment)}>
      {ENVIRONMENTS.map((env) => (
        <option key={env} value={env}>
          {env}
        </option>
      ))}
    </select>
  );
}

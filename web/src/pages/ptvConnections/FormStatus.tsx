/** The outcome of a "Save & test": a success note or an error. */
export interface FormStatusValue {
  ok: boolean;
  message: string;
}

export function FormStatus({ status }: { status: FormStatusValue | null }) {
  if (!status) return null;
  return <p className={status.ok ? 'muted' : 'error'}>{status.message}</p>;
}

import { useCallback, useState } from 'react';
import { errorMessage } from '../api/client';

/**
 * The message for a failed action: a fixed fallback (the server's own
 * message still wins for an `ApiError`, see `errorMessage`), or a function
 * for callers that map some errors to their own text.
 */
export type ActionErrorMessage = string | ((err: unknown) => string);

export interface AsyncAction {
  /** True while an action started by `run` is in flight. */
  busy: boolean;
  /** The last failed action's message; cleared when the next one starts. */
  error: string | null;
  setError(error: string | null): void;
  /**
   * Runs `action` with `busy` set, records its error message on failure and
   * resolves to whether it succeeded. Never rejects.
   */
  run(action: () => Promise<unknown>, message: ActionErrorMessage): Promise<boolean>;
}

/** The busy/error state around one panel's or form's async handlers. */
export function useAsyncAction(): AsyncAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<unknown>, message: ActionErrorMessage): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (err) {
        setError(typeof message === 'function' ? message(err) : errorMessage(err, message));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, error, setError, run };
}

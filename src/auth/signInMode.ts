/**
 * How people may sign in (`AUTH_MODE`):
 *
 * - `local`: password only (no OIDC configured).
 * - `both`: password and single sign-on (the default when OIDC is configured).
 * - `oidc`: single sign-on only. The password form is hidden, self-registration
 *   is refused, and password sign-in is accepted only for the break-glass
 *   accounts listed in `OIDC_BREAK_GLASS_EMAILS`.
 */
export const AUTH_MODES = ['local', 'both', 'oidc'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether a password may be checked for `email` under `mode`. */
export function isPasswordSignInAllowed(
  mode: AuthMode,
  breakGlassEmails: ReadonlySet<string>,
  email: string,
): boolean {
  if (mode !== 'oidc') return true;
  return breakGlassEmails.has(normalizeEmail(email));
}

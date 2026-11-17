import { describe, expect, it } from 'vitest';
import { isPasswordSignInAllowed } from './signInMode.js';

const breakGlass = new Set(['admin@example.test']);

describe('isPasswordSignInAllowed', () => {
  it('allows every email in local and both modes', () => {
    expect(isPasswordSignInAllowed('local', new Set(), 'anyone@example.test')).toBe(true);
    expect(isPasswordSignInAllowed('both', breakGlass, 'anyone@example.test')).toBe(true);
  });

  it('in oidc mode allows only break-glass emails, ignoring case and spaces', () => {
    expect(isPasswordSignInAllowed('oidc', breakGlass, 'admin@example.test')).toBe(true);
    expect(isPasswordSignInAllowed('oidc', breakGlass, ' Admin@Example.TEST ')).toBe(true);
    expect(isPasswordSignInAllowed('oidc', breakGlass, 'member@example.test')).toBe(false);
  });

  it('in oidc mode with no break-glass accounts refuses every password', () => {
    expect(isPasswordSignInAllowed('oidc', new Set(), 'admin@example.test')).toBe(false);
  });
});

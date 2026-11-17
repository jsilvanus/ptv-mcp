import { describe, expect, it, vi } from 'vitest';
import { checkDatabaseRole } from './rolePrivileges.js';

const plain = { rolsuper: false, rolbypassrls: false };

describe('checkDatabaseRole', () => {
  it('is silent for a plain role', () => {
    const warn = vi.fn();
    checkDatabaseRole(plain, { nodeEnv: 'production', allowPrivilegedDbRole: false }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a superuser or BYPASSRLS role in production', () => {
    const policy = { nodeEnv: 'production', allowPrivilegedDbRole: false } as const;
    expect(() => checkDatabaseRole({ ...plain, rolsuper: true }, policy, vi.fn())).toThrow(
      'SUPERUSER',
    );
    expect(() => checkDatabaseRole({ ...plain, rolbypassrls: true }, policy, vi.fn())).toThrow(
      'BYPASSRLS',
    );
  });

  it('only warns outside production', () => {
    const warn = vi.fn();
    checkDatabaseRole(
      { rolsuper: true, rolbypassrls: true },
      { nodeEnv: 'development', allowPrivilegedDbRole: false },
      warn,
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns instead of refusing with the opt-out', () => {
    const warn = vi.fn();
    checkDatabaseRole(
      { ...plain, rolsuper: true },
      { nodeEnv: 'production', allowPrivilegedDbRole: true },
      warn,
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});

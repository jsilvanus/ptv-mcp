import { describe, expect, it } from 'vitest';
import { parseCreateTenantArgs, TENANT_CREATE_USAGE } from './createTenant.js';

describe('parseCreateTenantArgs', () => {
  it('reads the three flags and lowercases the admin email', () => {
    expect(
      parseCreateTenantArgs([
        '--name',
        ' Riihimäen seurakunta ',
        '--slug',
        'riihimaki',
        '--admin-email',
        'Admin@Example.TEST ',
      ]),
    ).toEqual({
      name: 'Riihimäen seurakunta',
      slug: 'riihimaki',
      adminEmail: 'admin@example.test',
    });
  });

  it('refuses a missing flag with the usage line', () => {
    expect(() => parseCreateTenantArgs(['--name', 'X', '--slug', 'x'])).toThrow(
      TENANT_CREATE_USAGE,
    );
    expect(() =>
      parseCreateTenantArgs(['--name', '', '--slug', 'x', '--admin-email', 'a@b.c']),
    ).toThrow(TENANT_CREATE_USAGE);
  });

  it('refuses an unknown flag', () => {
    expect(() =>
      parseCreateTenantArgs([
        '--name',
        'X',
        '--slug',
        'x',
        '--admin-email',
        'a@b.c',
        '--role',
        'x',
      ]),
    ).toThrow();
  });
});

import postgres from 'postgres';

export interface DatabaseRole {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

export interface RolePolicy {
  nodeEnv: 'development' | 'test' | 'production';
  /** `ALLOW_PRIVILEGED_DB_ROLE` */
  allowPrivilegedDbRole: boolean;
}

/**
 * Row-level security does not bind a superuser or a `BYPASSRLS` role, so such
 * a connection silently turns the second tenant-isolation layer off. Refuses
 * (throws) in production unless opted out; otherwise reports a warning.
 */
export function checkDatabaseRole(
  role: DatabaseRole,
  policy: RolePolicy,
  warn: (message: string) => void,
): void {
  if (!role.rolsuper && !role.rolbypassrls) return;
  const kind = [role.rolsuper ? 'SUPERUSER' : null, role.rolbypassrls ? 'BYPASSRLS' : null]
    .filter(Boolean)
    .join(' and ');
  const message = `The database role has ${kind}, which bypasses row-level security (tenant isolation relies on it). Connect as a plain role.`;
  if (policy.allowPrivilegedDbRole) {
    warn(`${message} Continuing because ALLOW_PRIVILEGED_DB_ROLE is set.`);
    return;
  }
  if (policy.nodeEnv === 'production') {
    throw new Error(`${message} Set ALLOW_PRIVILEGED_DB_ROLE=true to start anyway.`);
  }
  warn(message);
}

/** Reads the current role's privileges and applies `checkDatabaseRole`. */
export async function assertDatabaseRole(
  databaseUrl: string,
  policy: RolePolicy,
  warn: (message: string) => void,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<DatabaseRole[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    const role = rows[0];
    if (role) checkDatabaseRole(role, policy, warn);
  } finally {
    await sql.end();
  }
}

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/auditService.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { TenantService } from './tenantService.js';

/**
 * Operator tool: creates a tenant with an existing account as its first
 * Tenant Admin. It works whether or not `ALLOW_TENANT_CREATION` is on, which
 * is the point: with the REST route disabled, this is how a tenant is made.
 *
 *   npm run tenant:create -- --name <name> --slug <slug> --admin-email <email>
 *   node dist/tenants/createTenant.js --name <name> --slug <slug> --admin-email <email>
 */

export const TENANT_CREATE_USAGE =
  'Usage: npm run tenant:create -- --name <name> --slug <slug> --admin-email <email>';

export interface CreateTenantArgs {
  name: string;
  slug: string;
  /** Lowercased, trimmed. The account must already exist. */
  adminEmail: string;
}

export function parseCreateTenantArgs(argv: readonly string[]): CreateTenantArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      'admin-email': { type: 'string' },
    },
    strict: true,
  });
  const name = values.name?.trim();
  const slug = values.slug?.trim();
  const adminEmail = values['admin-email']?.trim().toLowerCase();
  if (!name || !slug || !adminEmail) {
    throw new Error(TENANT_CREATE_USAGE);
  }
  return { name, slug, adminEmail };
}

/**
 * Creates the tenant through `TenantService.createTenant`, making the account
 * with `adminEmail` its Tenant Admin. Fails if no account has that email
 * (email match ignores case) or the slug is taken.
 */
export async function createTenantWithAdmin(
  db: Database,
  tenantService: TenantService,
  args: CreateTenantArgs,
): Promise<{ tenantId: string; adminUserId: string }> {
  const email = args.adminEmail.trim().toLowerCase();
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (!admin) {
    throw new Error(
      `No account is registered with ${email}. Register it first, then run this again.`,
    );
  }
  const { tenantId } = await tenantService.createTenant(args.name, args.slug, admin.id);
  return { tenantId, adminUserId: admin.id };
}

async function main(argv: string[]): Promise<void> {
  const args = parseCreateTenantArgs(argv);
  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  try {
    const tenantService = new TenantService(db, new AuditService(db));
    const { tenantId } = await createTenantWithAdmin(db, tenantService, args);
    console.log(
      `Created tenant "${args.name}" (slug ${args.slug}, id ${tenantId}). ${args.adminEmail} is its Tenant Admin.`,
    );
  } finally {
    await db.$client.end();
  }
}

// Run only when this file is the entry point (npm run / node), not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

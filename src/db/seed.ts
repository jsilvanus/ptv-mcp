// Local dev seed data. Note: querying `memberships`/`tenant_environments`/
// `ptv_adapter_configs`/`audit_entries` afterwards with plain `psql` will
// show 0 rows unless `app.current_tenant_id` is set first — RLS fails
// closed by design (see drizzle/0001_row_level_security.sql), including
// for this migration-owning role.
import { hash } from '@node-rs/argon2';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadConfig } from '../config.js';
import * as schema from './schema/index.js';

const config = loadConfig();
const client = postgres(config.databaseUrl);
const db = drizzle(client, { schema });

const [riihimaki, hausjarvi] = await db
  .insert(schema.tenants)
  .values([
    { name: 'Riihimäen seurakunta', slug: 'riihimaki' },
    { name: 'Hausjärven seurakunta', slug: 'hausjarvi' },
  ])
  .returning();

if (!riihimaki || !hausjarvi) {
  throw new Error('Seed failed: tenant insert did not return expected rows');
}

const passwordHash = await hash('dev-only-password');

const [juha] = await db
  .insert(schema.users)
  .values([{ email: 'juha@example.test', name: 'Juha Itäleino', passwordHash }])
  .returning();

if (!juha) {
  throw new Error('Seed failed: user insert did not return expected rows');
}

// `memberships` is tenant-scoped by Row-Level Security (enforced even for
// this migration-owning role — see drizzle/0001_row_level_security.sql),
// so each insert needs its own tenant's session context set first.
await client.begin(async (tx) => {
  await tx`SELECT set_config('app.current_tenant_id', ${riihimaki.id}, true)`;
  await tx`
    INSERT INTO memberships (user_id, tenant_id, role)
    VALUES (${juha.id}, ${riihimaki.id}, 'tenant_admin')
  `;
});
await client.begin(async (tx) => {
  await tx`SELECT set_config('app.current_tenant_id', ${hausjarvi.id}, true)`;
  await tx`
    INSERT INTO memberships (user_id, tenant_id, role)
    VALUES (${juha.id}, ${hausjarvi.id}, 'editor')
  `;
});

console.log('Seed complete:', {
  tenants: [riihimaki.slug, hausjarvi.slug],
  users: [juha.email],
});

await client.end();

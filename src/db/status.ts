import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { loadConfig } from '../config.js';

type MigrationFile = { name: string; hash: string };

const migrationsDir = join(process.cwd(), 'drizzle');
const files = (await readdir(migrationsDir))
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort();

const migrations: MigrationFile[] = [];
for (const name of files) {
  const sql = await readFile(join(migrationsDir, name), 'utf8');
  migrations.push({
    name: name.replace(/\.sql$/, ''),
    hash: createHash('sha256').update(sql).digest('hex'),
  });
}

const sql = postgres(loadConfig().databaseUrl, { max: 1 });

try {
  const rows = await sql.unsafe<{ id: number; hash: string; created_at: number }[]>(`
    SELECT id, hash, created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY id
  `);

  const appliedByHash = new Map(rows.map((row) => [row.hash, row]));

  console.log('Database migrations:');
  for (const migration of migrations) {
    const applied = appliedByHash.get(migration.hash);
    if (applied) {
      console.log(`  ✓ ${migration.name} (db id ${applied.id}, applied ${new Date(Number(applied.created_at)).toISOString()})`);
    } else {
      console.log(`  - ${migration.name} (PENDING)`);
    }
  }

  const knownHashes = new Set(migrations.map((migration) => migration.hash));
  for (const row of rows) {
    if (!knownHashes.has(row.hash)) {
      console.log(`  ? database migration id ${row.id} has no matching local SQL file (hash ${row.hash})`);
    }
  }

  const pending = migrations.filter((migration) => !appliedByHash.has(migration.hash));
  console.log(`\nSummary: ${migrations.length} local, ${rows.length} applied, ${pending.length} pending.`);
} finally {
  await sql.end();
}

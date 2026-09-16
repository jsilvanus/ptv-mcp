import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadConfig } from '../config.js';

const config = loadConfig();
const migrationClient = postgres(config.databaseUrl, { max: 1 });

await migrate(drizzle(migrationClient), { migrationsFolder: './drizzle' });

await migrationClient.end();

console.log('Migrations applied.');

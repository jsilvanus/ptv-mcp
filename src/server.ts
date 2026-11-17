import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertDatabaseRole } from './db/rolePrivileges.js';

const config = loadConfig();
await assertDatabaseRole(config.databaseUrl, config, (message) => console.warn(message));
const app = await buildApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

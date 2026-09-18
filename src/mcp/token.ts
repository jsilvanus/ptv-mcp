import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { createDatabase } from '../db/client.js';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const auth = new AuthService({
  db,
  jwtSecret: config.jwtSecret,
  mailer: new LoggingMailer(() => undefined),
});

const rl = createInterface({ input, output });

try {
  const email = (await rl.question('Email: ')).trim();
  const password = await rl.question('Password: ');

  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const session = await auth.login(email, password);

  console.log('\nMCP access token:');
  console.log(session.accessToken);
  console.log(`\nExpires in: ${session.expiresIn} seconds`);
  console.log('\nUse this as: Authorization: Bearer <token>');
} finally {
  rl.close();
  await db.$client.end();
}

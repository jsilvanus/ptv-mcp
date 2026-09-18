import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { createDatabase } from '../db/client.js';
import { OAuthService } from './oauthService.js';
import { jwtVerify } from 'jose';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const auth = new AuthService({
  db,
  jwtSecret: config.jwtSecret,
  mailer: new LoggingMailer(() => undefined),
});
const oauth = new OAuthService(
  db,
  config.jwtSecret,
  config.mcpPublicUrl,
  config.mcpPublicUrl + '/mcp',
);

const rl = createInterface({ input, output });

try {
  const email = (await rl.question('Email: ')).trim();
  const password = await rl.question('Password: ');

  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const session = await auth.login(email, password);
  const { payload } = await jwtVerify(
    session.accessToken,
    Buffer.from(config.jwtSecret, 'base64'),
    { algorithms: ['HS256'] },
  );
  if (typeof payload.sub !== 'string') {
    throw new Error('Application access token missing subject.');
  }

  const token = await oauth.issueAccessToken(
    payload.sub,
    'urn:ptv-mcp:dev-cli',
    'mcp',
  );

  console.log('\nCopy-paste this into your shell:');
  console.log(`export MCP_ACCESS_TOKEN='${token}'`);
  console.log('\nThen use it as:');
  console.log('Authorization: Bearer $MCP_ACCESS_TOKEN');
  console.log('\nExpires in: 3600 seconds');
} finally {
  rl.close();
  await db.$client.end();
}
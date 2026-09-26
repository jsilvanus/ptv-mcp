import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { AuthService } from '../auth/authService.js';
import { LoggingMailer } from '../auth/mailer.js';
import { createDatabase } from '../db/client.js';
import { AuditService } from '../audit/auditService.js';
import { TenantService } from '../tenants/tenantService.js';
import { OAuthService } from './oauthService.js';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const auth = new AuthService({
  db,
  jwtSecret: config.jwtSecret,
  mailer: new LoggingMailer(() => undefined),
});
const tenantService = new TenantService(db, new AuditService(db));
// issuer/resource must match src/app.ts's own OAuthService construction
// exactly — a token minted with a different `resource` (audience) than
// the running server validates against will always fail verification.
const oauth = new OAuthService(db, config.jwtSecret, config.mcpPublicUrl, config.mcpPublicUrl);

const rl = createInterface({ input, output });

try {
  const email = (await rl.question('Email: ')).trim();
  const password = await rl.question('Password: ');

  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  // verifyCredentials, not login: an MCP token needs no web-UI session.
  const userId = await auth.verifyCredentials(email, password);

  const memberships = await tenantService.listTenantsForUser(userId);
  if (memberships.length === 0) {
    throw new Error('This user has no tenant memberships to mint an MCP token for.');
  }
  let membership = memberships[0]!;
  if (memberships.length > 1) {
    memberships.forEach((m, i) =>
      console.log(`${i + 1}. ${m.tenantName} (${m.tenantSlug}) — ${m.role}`),
    );
    const choice = Number((await rl.question(`Tenant [1-${memberships.length}]: `)).trim() || '1');
    membership = memberships[choice - 1] ?? memberships[0]!;
  }

  const environmentInput = (await rl.question('Environment [test]: ')).trim();
  const environment = environmentInput === 'production' ? 'production' : 'test';
  const readApiVersion = (await rl.question('Read API version [v11]: ')).trim() || 'v11';
  const writeApiVersion = (await rl.question('Write API version [v11]: ')).trim() || 'v11';

  const token = await oauth.issueAccessToken(
    userId,
    'urn:ptv-mcp:dev-cli',
    'mcp',
    membership.tenantId,
    environment,
    readApiVersion,
    writeApiVersion,
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

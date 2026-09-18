import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AppConfig } from './config.js';
import { AuthService } from './auth/authService.js';
import { LoggingMailer, type Mailer } from './auth/mailer.js';
import { createDatabase, type Database } from './db/client.js';
import { UserPtvConnectionService } from './credentials/userPtvConnectionService.js';
import { TenantEnvironmentService } from './credentials/tenantEnvironmentService.js';
import { PtvAdapterConfigService } from './credentials/ptvAdapterConfigService.js';
import { TenantService } from './tenants/tenantService.js';
import { DbPtvAdapterRegistry } from './ptv/dbAdapterRegistry.js';
import type { AdapterFactory } from './ptv/dbAdapterRegistry.js';
import { AuditService } from './audit/auditService.js';
import { V11ChangeValidator } from './validation/changeValidator.js';
import { ProposalService } from './proposals/proposalService.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { ptvConnectionRoutes } from './routes/ptvConnections.js';
import { auditLogRoutes } from './routes/auditLog.js';
import { proposalRoutes } from './routes/proposals.js';
import { webUiRoutes } from './routes/webUi.js';
import { ptvV12Routes } from './routes/ptvV12.js';
import { mcpRoutes } from './mcp/httpTransport.js';
import { mcpOAuthRoutes } from './mcp/oauthRoutes.js';
import { OAuthService } from './mcp/oauthService.js';

export interface BuildAppOptions {
  config: Pick<
    AppConfig,
    | 'logLevel'
    | 'nodeEnv'
    | 'databaseUrl'
    | 'jwtSecret'
    | 'masterEncryptionKey'
    | 'ptvV11OAuthClientId'
    | 'ptvV11OAuthClientSecret'
    | 'ptvV11OAuthRedirectUri'
    | 'mcpPublicUrl'
  >;
  db?: Database;
  mailer?: Mailer;
  adapterFactories?: Record<string, AdapterFactory>;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app: FastifyInstance = Fastify({
    logger:
      config.nodeEnv === 'production'
        ? { level: config.logLevel }
        : { level: config.logLevel, transport: { target: 'pino-pretty' } },
  });

  const db = options.db ?? createDatabase(config.databaseUrl);
  const mailer = options.mailer ?? new LoggingMailer((message) => app.log.info(message));
  const authService = new AuthService({ db, jwtSecret: config.jwtSecret, mailer });
  const oauthService = new OAuthService(db, config.jwtSecret, config.mcpPublicUrl, config.mcpPublicUrl);
  const auditService = new AuditService(db);
  const tenantService = new TenantService(db, auditService);
  const connectionService = new UserPtvConnectionService(db, config.masterEncryptionKey);
  const tenantEnvironmentService = new TenantEnvironmentService(db, config.masterEncryptionKey);
  const adapterConfigService = new PtvAdapterConfigService(db);
  const registry = new DbPtvAdapterRegistry(
    db,
    adapterConfigService,
    tenantEnvironmentService,
    connectionService,
    options.adapterFactories,
  );
  const validator = new V11ChangeValidator();
  const proposalService = new ProposalService(db);

  await app.register(sensible);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  await app.register(healthRoutes);
  await app.register(authRoutes, { authService, jwtSecret: config.jwtSecret });
  await app.register(tenantRoutes, { tenantService, jwtSecret: config.jwtSecret, db });
  await app.register(ptvConnectionRoutes, {
    connectionService,
    tenantService,
    auditService,
    jwtSecret: config.jwtSecret,
    oauth: {
      clientId: config.ptvV11OAuthClientId,
      clientSecret: config.ptvV11OAuthClientSecret,
      redirectUri: config.ptvV11OAuthRedirectUri,
    },
  });
  await app.register(mcpOAuthRoutes, { oauthService, authService, tenantService, publicUrl: config.mcpPublicUrl, jwtSecret: config.jwtSecret });
  await app.register(mcpRoutes, {
    jwtSecret: config.jwtSecret,
    oauthService,
    publicUrl: config.mcpPublicUrl,
    serverDeps: { db, registry, auditService, validator, proposalService },
  });
  await app.register(auditLogRoutes, { auditService, jwtSecret: config.jwtSecret, db });
  await app.register(proposalRoutes, {
    db,
    jwtSecret: config.jwtSecret,
    proposalService,
    registry,
    auditService,
    validator,
  });
  await app.register(ptvV12Routes, { tenantEnvironmentService, adapterConfigService, db, jwtSecret: config.jwtSecret });
  await app.register(webUiRoutes, { nodeEnv: config.nodeEnv });

  return app;
}

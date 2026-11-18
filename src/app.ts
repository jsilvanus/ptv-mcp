import type { AuthMode } from './auth/signInMode.js';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AppConfig } from './config.js';
import { AuthService } from './auth/authService.js';
import { LoggingMailer, type Mailer } from './auth/mailer.js';
import { createDatabase, type Database } from './db/client.js';
import { PtvOrganizationCacheService } from './db/ptvOrganizationCacheService.js';
import { PtvCodeNameCacheService } from './db/ptvCodeNameCacheService.js';
import { CodeNameCache, DEFAULT_CODE_NAME_TTL_MS } from './ptv/v12/codeNameCache.js';
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
import { reviewRoutes } from './routes/reviews.js';
import { contentExportRoutes } from './routes/contentExport.js';
import { webUiRoutes } from './routes/webUi.js';
import { registerSpaNavigation } from './routes/spaNavigation.js';
import { routeErrorHandler } from './routes/errorHandler.js';
import { ptvV12Routes } from './routes/ptvV12.js';
import { ptvV11ApiUserRoutes } from './routes/ptvV11ApiUser.js';
import { mcpRoutes } from './mcp/httpTransport.js';
import { mcpOAuthRoutes } from './mcp/oauthRoutes.js';
import { OAuthService } from './mcp/oauthService.js';
import { OidcClient } from './oidc/oidcClient.js';
import { OidcService } from './oidc/oidcService.js';
import { oidcRoutes } from './routes/oidc.js';

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
    | 'webDevUrl'
    | 'oidc'
  > & {
    /** Optional public URL path prefix; defaults to the root installation. */
    domainPath?: string;
    /** Optional so existing callers that build the app without it keep compiling; defaults to false. */
    requireVerifiedEmail?: boolean;
    /** Optional, as `requireVerifiedEmail`: defaults to `both` with OIDC configured, else `local`. */
    authMode?: AuthMode;
    breakGlassEmails?: string[];
    /** Optional, as `requireVerifiedEmail`: defaults to true (`ALLOW_TENANT_CREATION`). */
    allowTenantCreation?: boolean;
  };
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
  const requireVerifiedEmail = config.requireVerifiedEmail ?? false;
  const authMode: AuthMode = config.authMode ?? (config.oidc ? 'both' : 'local');
  const breakGlassEmails = config.breakGlassEmails ?? [];
  if (authMode === 'oidc' && breakGlassEmails.length === 0) {
    app.log.warn('AUTH_MODE=oidc without OIDC_BREAK_GLASS_EMAILS: no password sign-in is possible');
  }
  const authService = new AuthService({
    db,
    jwtSecret: config.jwtSecret,
    masterEncryptionKey: config.masterEncryptionKey,
    mailer,
    requireVerifiedEmail,
    authMode,
    breakGlassEmails,
  });
  const oauthService = new OAuthService(
    db,
    config.jwtSecret,
    config.mcpPublicUrl,
    config.mcpPublicUrl,
  );
  const auditService = new AuditService(db);
  const tenantService = new TenantService(db, auditService, { requireVerifiedEmail });
  const connectionService = new UserPtvConnectionService(db, config.masterEncryptionKey);
  const tenantEnvironmentService = new TenantEnvironmentService(db, config.masterEncryptionKey);
  const adapterConfigService = new PtvAdapterConfigService(db);
  const organizationCache = new PtvOrganizationCacheService(db);
  const codeNameCache = new CodeNameCache(
    DEFAULT_CODE_NAME_TTL_MS,
    Date.now,
    new PtvCodeNameCacheService(db),
  );
  const registry = new DbPtvAdapterRegistry(
    db,
    adapterConfigService,
    tenantEnvironmentService,
    connectionService,
    options.adapterFactories,
    organizationCache,
    codeNameCache,
  );
  const validator = new V11ChangeValidator();
  const proposalService = new ProposalService(db);

  await app.register(sensible);
  // Before any route: a route captures the error handler it is registered under.
  app.setErrorHandler(routeErrorHandler);
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
  registerSpaNavigation(app, {
    nodeEnv: config.nodeEnv,
    webDevUrl: config.webDevUrl ?? 'http://127.0.0.1:5173',
    domainPath: config.domainPath ?? '',
  });
  await app.register(healthRoutes);
  const oidcClient = config.oidc
    ? new OidcClient(
        config.oidc,
        `${config.mcpPublicUrl.replace(/\/+$/, '')}/oidc/callback`,
        config.oidc.postLogoutRedirectUri ?? `${config.mcpPublicUrl.replace(/\/+$/, '')}/login`,
      )
    : undefined;
  await app.register(authRoutes, {
    authService,
    jwtSecret: config.jwtSecret,
    ...(oidcClient
      ? {
          endSessionUrl: (idTokenHint: string) =>
            oidcClient.endSessionUrl(idTokenHint).then((url) => url?.toString() ?? null),
        }
      : {}),
  });
  await app.register(tenantRoutes, {
    tenantService,
    jwtSecret: config.jwtSecret,
    db,
    allowTenantCreation: config.allowTenantCreation ?? true,
  });
  await app.register(ptvConnectionRoutes, {
    connectionService,
    tenantService,
    adapterConfigService,
    auditService,
    jwtSecret: config.jwtSecret,
    oauth: {
      clientId: config.ptvV11OAuthClientId,
      clientSecret: config.ptvV11OAuthClientSecret,
      redirectUri: config.ptvV11OAuthRedirectUri,
    },
  });
  await app.register(mcpOAuthRoutes, {
    oauthService,
    authService,
    tenantService,
    adapterConfigService,
    publicUrl: config.mcpPublicUrl,
    ...(config.oidc ? { oidcButtonLabel: config.oidc.buttonLabel } : {}),
    ssoOnly: authMode === 'oidc',
  });
  if (oidcClient && config.oidc) {
    await app.register(oidcRoutes, {
      oidcClient: oidcClient!,
      oidcService: new OidcService(db, {
        createUsers: config.oidc.createUsers,
        trustEmail: config.oidc.trustEmail,
        masterEncryptionKey: config.masterEncryptionKey,
        ...(config.oidc.groupSync ? { groupSync: config.oidc.groupSync } : {}),
        auditService,
      }),
      authService,
      oauthService,
      tenantService,
      publicUrl: config.mcpPublicUrl,
      buttonLabel: config.oidc.buttonLabel,
      ssoOnly: authMode === 'oidc',
      secureCookies: config.nodeEnv === 'production',
    });
  }
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
    adapterConfigService,
  });
  await app.register(reviewRoutes, { db, jwtSecret: config.jwtSecret, registry, auditService });
  await app.register(contentExportRoutes, {
    db,
    jwtSecret: config.jwtSecret,
    registry,
    auditService,
  });
  await app.register(ptvV12Routes, {
    tenantEnvironmentService,
    adapterConfigService,
    auditService,
    db,
    jwtSecret: config.jwtSecret,
  });
  await app.register(ptvV11ApiUserRoutes, {
    tenantEnvironmentService,
    adapterConfigService,
    auditService,
    db,
    jwtSecret: config.jwtSecret,
  });
  await app.register(webUiRoutes, {
    nodeEnv: config.nodeEnv,
    domainPath: config.domainPath ?? '',
  });

  return app;
}

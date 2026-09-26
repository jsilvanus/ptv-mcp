import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { PtvAdapterResolutionError } from '../../ptv/registry.js';
import type { ChangeValidator } from '../../validation/changeValidator.js';
import type { ReviewDeps } from '../../reviews/reviewCampaigns.js';
import type { FourEyesResolver } from '../authorization.js';
import type { ReadToolContext, ToolContext } from '../toolContext.js';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * What the tool modules need. `ReviewDeps` already carries the (per-request
 * memoised) role resolver, adapter registry, audit and proposal services
 * and member lookup; tools add the validator and the four-eyes lookup.
 */
export interface ToolDeps extends ReviewDeps {
  validator: ChangeValidator;
  requireFourEyes: FourEyesResolver;
}

/**
 * Registers an OAuth-protected tool whose result is `run`'s value as
 * JSON; anything it throws becomes a tool error (see `errorResult`).
 */
export type RegisterTool = <Shape extends ZodRawShapeCompat>(
  name: string,
  config: { description: string; inputSchema: Shape },
  run: (args: ShapeOutput<Shape>, extra: Extra) => Promise<unknown>,
) => void;

const oauthSecuritySchemes = [{ type: 'oauth2' as const, scopes: ['mcp'] }];

export function toolRegistrar(server: McpServer, publicUrl?: string): RegisterTool {
  return (name, config, run) => {
    const callback = async (
      args: Parameters<typeof run>[0],
      extra: Extra,
    ): Promise<CallToolResult> => {
      try {
        return textResult(await run(args, extra));
      } catch (err) {
        return errorResult(err, publicUrl);
      }
    };
    // `securitySchemes` isn't in the SDK's config type yet; clients read it
    // from the tool listing, so it goes through as an extra property.
    const withSecurity = { ...config, securitySchemes: oauthSecuritySchemes };
    server.registerTool(name, withSecurity, callback as ToolCallback<typeof config.inputSchema>);
  };
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Thrown when a call has no verified access token; tools answer it with the OAuth challenge. */
export class AuthenticationRequiredError extends Error {
  constructor() {
    super('No authenticated user for this MCP session');
    this.name = 'AuthenticationRequiredError';
  }
}

/**
 * Every business error this layer throws maps to a *tool* error
 * (`isError: true` in the result), not a protocol-level failure — an
 * agent calling e.g. `ptv_apply_changes` with an invalid proposal should
 * get back a readable reason, not a transport exception.
 */
function errorResult(err: unknown, publicUrl?: string): CallToolResult {
  if (err instanceof AuthenticationRequiredError && publicUrl) {
    return {
      content: [{ type: 'text', text: 'Authentication required: no access token provided.' }],
      _meta: {
        'mcp/www_authenticate': [
          `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="You need to login to continue"`,
        ],
      },
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

function describeError(err: unknown): string {
  if (err instanceof PtvAdapterResolutionError) {
    return `${err.reason}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolves the acting user from the bearer token our own HTTP transport
 * layer (mcp/httpTransport.ts) already verified and stashed on `authInfo.extra`
 * — never trust a `userId` supplied as a tool argument, since that would let
 * one authenticated caller act as anyone.
 */
function actingUserId(extra: Extra): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== 'string' || userId === '') {
    throw new AuthenticationRequiredError();
  }
  return userId;
}

/** The token's read API version; every connection has one. */
function readApiVersionOf(extra: Extra): string {
  const readApiVersion = extra.authInfo?.extra?.readApiVersion;
  if (typeof readApiVersion !== 'string' || readApiVersion === '') {
    throw new Error(
      'No active PTV read API version for this MCP connection; reconnect and select a connection',
    );
  }
  return readApiVersion;
}

function writeApiVersionField(extra: Extra): { writeApiVersion?: string } {
  const writeApiVersion = extra.authInfo?.extra?.writeApiVersion;
  return typeof writeApiVersion === 'string' ? { writeApiVersion } : {};
}

export function toolContext(extra: Extra): ToolContext {
  const { tenantId, ...rest } = readToolContext(extra);
  if (!tenantId) {
    throw new Error(
      'This MCP connection has no organisation (public PTV data only). Proposals and writes need an organisation: reconnect and choose one.',
    );
  }
  return { tenantId, ...rest };
}

/**
 * Read tools also work on a public connection without an organisation:
 * then the tenant is absent and only PTV v11's published data is read.
 */
export function readToolContext(extra: Extra): ReadToolContext {
  const userId = actingUserId(extra);
  const activeTenantId = extra.authInfo?.extra?.tenantId;
  const environment = extra.authInfo?.extra?.environment;
  if (environment !== 'test' && environment !== 'production') {
    throw new Error(
      'No active PTV environment for this MCP connection; reconnect and select a connection',
    );
  }
  const readApiVersion = readApiVersionOf(extra);
  return {
    ...(typeof activeTenantId === 'string' && activeTenantId !== ''
      ? { tenantId: activeTenantId }
      : {}),
    environment,
    readApiVersion,
    ...writeApiVersionField(extra),
    actingUserId: userId,
  };
}

/**
 * Resource reads carry tenant/environment in the URI itself (the
 * `ptv://{tenantId}/{environment}/...` templates in ../resources.ts),
 * unlike tools, which have no per-call channel for either and take both
 * from the OAuth token (see `toolContext()` above). Read/write API version
 * and the acting user still come from the token. Accepting whatever
 * tenantId the URI names doesn't bypass anything:
 * `PtvAdapterRegistry.resolve()` re-checks that `actingUserId` actually
 * belongs to that tenant before ever touching a credential, exactly as it
 * does for a tool call.
 */
export function resourceToolContext(
  extra: Extra,
  uriTenantId: string,
  uriEnvironment: string,
): ToolContext {
  const userId = actingUserId(extra);
  if (uriEnvironment !== 'test' && uriEnvironment !== 'production') {
    throw new Error(`Invalid PTV environment in resource URI: ${uriEnvironment}`);
  }
  const readApiVersion = readApiVersionOf(extra);
  return {
    tenantId: uriTenantId,
    environment: uriEnvironment,
    readApiVersion,
    ...writeApiVersionField(extra),
    actingUserId: userId,
  };
}

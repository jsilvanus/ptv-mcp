import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidOrExpiredTokenError,
} from '../auth/authService.js';
import { FourEyesError, NotAuthorizedError } from '../mcp/authorization.js';
import {
  InvalidCommentError,
  InvalidReviewRequestError,
  ManualPublishCheckError,
  ReviewsPendingError,
} from '../mcp/proposalQueue.js';
import {
  NotARequestedReviewerError,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
} from '../proposals/proposalService.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import { ReviewCampaignError } from '../reviews/reviewCampaigns.js';
import { ReviewCampaignNotFoundError, ReviewItemNotFoundError } from '../reviews/reviewService.js';
import {
  MembershipNotFoundError,
  SlugAlreadyTakenError,
  TenantNotFoundError,
  UserNotFoundError,
} from '../tenants/tenantService.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErrorClass = new (...args: any[]) => Error;

interface MappedError {
  statusCode: number;
  message: string;
}

/**
 * Domain errors a REST route lets escape, and the HTTP status each one
 * becomes. A route that needs a different status for one of these (e.g.
 * `/auth/refresh` answering 401 for an expired token) catches it itself.
 */
const ERROR_STATUS: ReadonlyArray<readonly [ErrorClass, number | ((err: Error) => MappedError)]> = [
  [ProposalNotFoundError, 404],
  [ProposalAlreadyResolvedError, 409],
  [ReviewsPendingError, 409],
  [ManualPublishCheckError, 409],
  [InvalidCommentError, 400],
  [InvalidReviewRequestError, 400],
  [NotARequestedReviewerError, 403],
  [NotAuthorizedError, 403],
  [FourEyesError, 403],
  [
    PtvAdapterResolutionError,
    (err) => {
      const { reason, message } = err as PtvAdapterResolutionError;
      return reason === 'not_authorized'
        ? { statusCode: 403, message }
        : { statusCode: 400, message: `${reason}: ${message}` };
    },
  ],
  [ReviewCampaignNotFoundError, 404],
  [ReviewItemNotFoundError, 404],
  [ReviewCampaignError, 400],
  [TenantNotFoundError, 404],
  [SlugAlreadyTakenError, 409],
  [UserNotFoundError, 404],
  [MembershipNotFoundError, 404],
  [EmailAlreadyRegisteredError, 409],
  [InvalidCredentialsError, 401],
  [InvalidOrExpiredTokenError, 400],
];

export function httpErrorFor(error: unknown): MappedError | undefined {
  for (const [errorClass, mapping] of ERROR_STATUS) {
    if (error instanceof errorClass) {
      return typeof mapping === 'number'
        ? { statusCode: mapping, message: error.message }
        : mapping(error);
    }
  }
  return undefined;
}

/**
 * The app's error handler: turns a known domain error into the same
 * response `reply.notFound(message)` etc. would give. Throwing hands the
 * error on to Fastify's default handler, which logs and serialises it
 * (and handles everything not in the table, as before).
 */
export function routeErrorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): never {
  const mapped = httpErrorFor(error);
  if (!mapped) throw error;
  throw reply.server.httpErrors.createError(mapped.statusCode, mapped.message);
}

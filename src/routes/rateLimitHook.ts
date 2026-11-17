import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FixedWindowRateLimiter } from '../oidc/rateLimit.js';

/**
 * A `preHandler` that counts the request against `limiter` (keyed by client IP)
 * and answers 429 once over the limit. `onLimited` overrides the default JSON
 * answer, e.g. for an HTML page.
 */
export function rateLimitHook(
  limiter: Pick<FixedWindowRateLimiter, 'allow'>,
  onLimited?: (reply: FastifyReply) => unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (limiter.allow(request.ip)) return;
    reply.header('retry-after', '60');
    if (onLimited) {
      await onLimited(reply);
    } else {
      await reply.code(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many requests. Please wait a minute and try again.',
      });
    }
  };
}

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../oidc/rateLimit.js';
import { rateLimitHook } from './rateLimitHook.js';

describe('rateLimitHook', () => {
  it('answers 429 with Retry-After once the limit is exceeded', async () => {
    const app = Fastify();
    app.post(
      '/x',
      { preHandler: rateLimitHook(new FixedWindowRateLimiter(2, 60_000)) },
      async () => ({
        ok: true,
      }),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/x' });
      statuses.push(res.statusCode);
      if (i === 2) expect(res.headers['retry-after']).toBe('60');
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('uses a custom answer when given', async () => {
    const app = Fastify();
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    app.get(
      '/x',
      {
        preHandler: rateLimitHook(limiter, (reply) =>
          reply.code(429).type('text/html').send('slow'),
        ),
      },
      async () => 'ok',
    );
    await app.inject({ method: 'GET', url: '/x' });
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(429);
    expect(res.body).toBe('slow');
  });
});

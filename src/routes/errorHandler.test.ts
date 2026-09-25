import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { describe, expect, it } from 'vitest';
import { ProposalNotFoundError } from '../proposals/proposalService.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import { routeErrorHandler } from './errorHandler.js';

async function buildTestApp() {
  const app = Fastify();
  await app.register(sensible);
  app.setErrorHandler(routeErrorHandler);
  app.get('/sensible', async (_request, reply) => reply.notFound('Proposal not found: p1'));
  app.get('/thrown', async () => {
    throw new ProposalNotFoundError('p1');
  });
  app.get('/resolution/:reason', async (request) => {
    const { reason } = request.params as { reason: PtvAdapterResolutionError['reason'] };
    throw new PtvAdapterResolutionError('no adapter', reason);
  });
  app.get('/unknown', async () => {
    throw new Error('boom');
  });
  return app;
}

describe('routeErrorHandler', () => {
  it('answers a domain error exactly like the matching reply helper', async () => {
    const app = await buildTestApp();
    const viaHelper = await app.inject({ method: 'GET', url: '/sensible' });
    const viaHandler = await app.inject({ method: 'GET', url: '/thrown' });
    expect(viaHandler.statusCode).toBe(404);
    expect(viaHandler.json()).toEqual(viaHelper.json());
  });

  it('maps adapter resolution errors by reason', async () => {
    const app = await buildTestApp();
    const forbidden = await app.inject({ method: 'GET', url: '/resolution/not_authorized' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().message).toBe('no adapter');
    const bad = await app.inject({ method: 'GET', url: '/resolution/no_adapter_configured' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe('no_adapter_configured: no adapter');
  });

  it('leaves other errors to Fastify as 500s', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/unknown' });
    expect(res.statusCode).toBe(500);
  });
});

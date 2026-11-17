import { describe, expect, it } from 'vitest';
import { describeFailure, PtvV11ApiError, PtvV11Client } from './client.js';

describe('describeFailure', () => {
  it('renders PTV field errors one per line (live 400 body)', () => {
    const body = JSON.stringify({
      TargetGroups: ["The field is required when 'GeneralDescriptionId' has value 'null'."],
      PublishingStatus: ['The PublishingStatus field is required.'],
    });
    expect(describeFailure('PUT', '/api/v11/Service/x', 400, body)).toBe(
      [
        'PTV rejected PUT /api/v11/Service/x (400):',
        "- TargetGroups: The field is required when 'GeneralDescriptionId' has value 'null'.",
        '- PublishingStatus: The PublishingStatus field is required.',
      ].join('\n'),
    );
  });

  it('reads field errors from a ProblemDetails `errors` object', () => {
    const body = JSON.stringify({ title: 'Bad', errors: { Name: ['Too long'] } });
    expect(describeFailure('POST', '/p', 400, body)).toContain('- Name: Too long');
  });

  it('passes a non-JSON body through, truncated', () => {
    const message = describeFailure('GET', '/p', 500, 'x'.repeat(3000));
    expect(message.startsWith('PTV v11 request failed: GET /p -> 500 xxx')).toBe(true);
    expect(message.length).toBeLessThan(2100);
  });
});

describe('PtvV11Client error surfacing', () => {
  it('throws PtvV11ApiError with the readable message and no token', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ Name: ['Required'] }), { status: 400 })) as typeof fetch;
    const client = new PtvV11Client({
      environment: 'test',
      fetchImpl,
      writeTokenProvider: { getToken: async () => 'secret-token', invalidate: () => {} },
    });
    const error = await client.put('/api/v11/Service/x', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PtvV11ApiError);
    expect((error as Error).message).toContain('- Name: Required');
    expect((error as Error).message).not.toContain('secret-token');
  });
});

describe('PtvV11Client retries and timeouts', () => {
  const provider = { getToken: async () => 't', invalidate: () => {} };

  it('does not retry a POST that got a 5xx', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('boom', { status: 503 });
    }) as typeof fetch;
    const client = new PtvV11Client({
      environment: 'test',
      fetchImpl,
      writeTokenProvider: provider,
    });
    await expect(client.post('/api/v11/Service', {})).rejects.toBeInstanceOf(PtvV11ApiError);
    expect(calls).toBe(1);
  });

  it('does not retry a POST after a network error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('socket hang up');
    }) as typeof fetch;
    const client = new PtvV11Client({
      environment: 'test',
      fetchImpl,
      writeTokenProvider: provider,
    });
    await expect(client.post('/api/v11/Service', {})).rejects.toThrow('socket hang up');
    expect(calls).toBe(1);
  });

  it('still retries a PUT on 503', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? new Response('boom', { status: 503, headers: { 'Retry-After': '0' } })
        : new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = new PtvV11Client({
      environment: 'test',
      fetchImpl,
      writeTokenProvider: provider,
    });
    await client.put('/api/v11/Service/x', {});
    expect(calls).toBe(2);
  });

  it('passes an abort signal that fires after timeoutMs', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const client = new PtvV11Client({
      environment: 'test',
      fetchImpl,
      maxRetries: 0,
      timeoutMs: 20,
    });
    await expect(client.get('/api/v11/Service/x')).rejects.toThrow('aborted');
  });
});

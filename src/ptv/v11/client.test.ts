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

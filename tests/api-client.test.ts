import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { callRestApi, type ApiCallOptions } from '../src/api-client.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));

const options: ApiCallOptions = {
  method: 'GET',
  path: '/strategies',
  apiKey: 'private-api-key',
  apiSecret: 'private-api-secret',
  requestId: 'test-request-123',
};
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CPZ_API_TIMEOUT_MS', '20000');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('REST client request contract', () => {
  it('preserves successful data and forwards credentials, request ID, user-agent, query, and timeout', async () => {
    const data = { data: [{ id: 'strategy-1' }], count: 1 };
    const fetchMock = vi.fn().mockResolvedValue(json(data));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callRestApi({ ...options, query: { title: 'alpha & beta', limit: '10' } });

    expect(result).toEqual({ ok: true, status: 200, data, requestId: 'test-request-123' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.get('title')).toBe('alpha & beta');
    expect(new URL(url).searchParams.get('limit')).toBe('10');
    expect(init.headers).toMatchObject({
      'X-CPZ-Key': options.apiKey,
      'X-CPZ-Secret': options.apiSecret,
      'x-request-id': options.requestId,
      'User-Agent': 'CPZ Lab (support@cpz-lab.com)',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(delay).not.toHaveBeenCalled();
  });

  it.each([undefined, 'unsafe\nrequest-id', 'x'.repeat(129)])('generates a safe correlation ID for %j', async (requestId) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callRestApi({ ...options, requestId });
    expect(result.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(fetchMock.mock.calls[0][1].headers['x-request-id']).toBe(result.requestId);
  });

  it.each(['', 'NaN', '-1', '0', '1.5', '120001', '20000garbage'])('rejects invalid timeout configuration %j without sending a request', async (timeout) => {
    vi.stubEnv('CPZ_API_TIMEOUT_MS', timeout);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await callRestApi(options);
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      data: { code: 'invalid_timeout_configuration', request_id: options.requestId },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the configured bounded timeout for fetch', async () => {
    vi.stubEnv('CPZ_API_TIMEOUT_MS', '120000');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: [] })));
    await callRestApi(options);
    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy.mock.calls[0][0]).toBeGreaterThan(119000);
    expect(timeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(120000);
  });
});

describe('honest failures', () => {
  it.each(['TimeoutError', 'AbortError'])('marks a mutation %s as unknown outcome without replay', async (name) => {
    const error = new Error('timeout');
    error.name = name;
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetchMock);
    const result = await callRestApi({ ...options, method: 'POST', path: '/orders', body: { quantity: 1 } });
    expect(result).toMatchObject({
      ok: false,
      status: 504,
      data: { code: 'upstream_timeout', operation_outcome: 'unknown', request_id: options.requestId },
    });
    expect(JSON.stringify(result.data)).not.toContain('did NOT complete');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      resource: 'orders', method: 'POST', request_id: options.requestId, operation_outcome: 'unknown',
    }));
  });

  it('does not leak credentials, request bodies or raw transport errors in money-path logs', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`failed ${options.apiSecret}`));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callRestApi({ ...options, method: 'POST', path: '/execute', body: { secret: 'payload-secret' } });
    expect(result).toMatchObject({ status: 502, data: { operation_outcome: 'unknown', code: 'upstream_network_error' } });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(options.apiKey);
    expect(logged).not.toContain(options.apiSecret);
    expect(logged).not.toContain('payload-secret');
    expect(JSON.stringify(result)).not.toContain(options.apiSecret);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns 502 for a non-JSON HTTP 200 response and marks a mutation outcome unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>gateway failure</html>'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callRestApi({ ...options, method: 'POST', path: '/orders' });
    expect(result).toMatchObject({
      ok: false, status: 502,
      data: { code: 'invalid_upstream_response', upstream_status: 200, operation_outcome: 'unknown' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats a response-body timeout as a timeout with an unknown mutation outcome', async () => {
    const error = new Error('body stalled');
    error.name = 'TimeoutError';
    const response = json({});
    vi.spyOn(response, 'json').mockRejectedValue(error);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect(await callRestApi({ ...options, method: 'POST', path: '/orders' })).toMatchObject({
      ok: false, status: 504, data: { code: 'upstream_timeout', upstream_status: 200, operation_outcome: 'unknown' },
    });
  });

  it.each([{ error: 'Provider down' }, { error: { message: 'Rejected' } }, { success: false }, { ok: false }])('rejects an HTTP 200 logical error envelope %j', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(json(body));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({
      ok: false, status: 502, data: { code: 'upstream_logical_error', upstream_status: 200 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not confuse empty error fields or errors inside returned records with an envelope failure', async () => {
    const data = { error: null, data: [{ error: 'Historical failure', success: false }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(data)));
    expect(await callRestApi(options)).toMatchObject({ ok: true, status: 200, data });
  });

  it('surfaces Python execution errors while preserving execution identity and output', async () => {
    const payload = { ok: true, execution_id: 'execution-123', status: 200, body: '{"error":"Invalid strategy"}', hasPythonError: true };
    const fetchMock = vi.fn().mockResolvedValue(json(payload));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi({ ...options, path: '/execute', method: 'POST' })).toMatchObject({
      ok: false,
      status: 502,
      data: { ...payload, ok: false, upstream_ok: true, code: 'upstream_logical_error', operation_outcome: 'unknown' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([{ error: 'Account unavailable' }, { success: false }])('surfaces partial portfolio sync failures and retains successes: %j', async (failedAccount) => {
    const payload = { success: true, results: [{ account_id: 'account-1', success: true, positions_synced: 5 }, { account_id: 'account-2', ...failedAccount }] };
    const fetchMock = vi.fn().mockResolvedValue(json(payload));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi({ ...options, path: '/portfolio-sync', method: 'POST' })).toMatchObject({
      ok: false, status: 502, data: { ...payload, success: false, upstream_success: true, code: 'upstream_logical_error', operation_outcome: 'unknown' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['/execute', { ok: true, hasPythonError: false, body: 'success' }],
    ['/portfolio-sync', { success: true, results: [{ success: true, error: null }] }],
    ['/backtests', { data: { hasPythonError: true, results: [{ error: 'Historical failure' }] } }],
    ['/backtests', { hasPythonError: true, results: [{ error: 'Historical failure' }] }],
  ])('does not recursively misclassify successful or historical data from %s', async (path, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload)));
    expect(await callRestApi({ ...options, path })).toMatchObject({ ok: true, status: 200, data: payload });
  });

  it('preserves provider error details while adding correlation and client classification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Not allowed', code: 'insufficient_scope', required: ['orders'] }, 403)));
    expect(await callRestApi(options)).toMatchObject({
      ok: false, status: 403,
      data: { error: 'Not allowed', code: 'upstream_http_error', upstream_code: 'insufficient_scope', required: ['orders'], request_id: options.requestId },
    });
  });
});

describe('bounded GET-only retries', () => {
  it('retries 429 after Retry-After and preserves one request ID across attempts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Rate limited' }, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: true });
    expect(delay).toHaveBeenCalledWith(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers['x-request-id'])).toEqual([options.requestId, options.requestId]);
    expect(fetchMock.mock.calls[0][1].signal).not.toBe(fetchMock.mock.calls[1][1].signal);
  });

  it('honors an HTTP-date Retry-After', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 14, 12, 0, 0));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Unavailable' }, 503, { 'Retry-After': 'Mon, 14 Sep 2026 12:00:03 GMT' }))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: true });
    expect(delay).toHaveBeenCalledWith(3000);
  });

  it.each(['10', '99999999999999999999999999999999'])('returns a rate limit failure instead of retrying sooner than a long Retry-After %s', async (retryAfter) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'Rate limited' }, 429, { 'Retry-After': retryAfter }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: false, status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not wait beyond the remaining request budget', async () => {
    vi.stubEnv('CPZ_API_TIMEOUT_MS', '1000');
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'Rate limited' }, 429, { 'Retry-After': '2' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: false, status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not start another attempt if a delayed timer resumes after the deadline', async () => {
    let now = Date.UTC(2026, 8, 14);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(delay).mockImplementationOnce(async () => { now += 30_000; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Unavailable' }, 503))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: false, status: 504, data: { code: 'upstream_timeout' } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('limits transient server failures to three attempts with jittered backoff', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ error: 'Unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.mocked(delay).mock.calls).toEqual([[300], [500]]);
  });

  it('can recover from a non-JSON gateway error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failed GET connection', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'Request refused' }, status));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi(options)).toMatchObject({ ok: false, status });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('never replays %s after a 503 response', async (method) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'Unavailable' }, 503, { 'Retry-After': '0' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi({ ...options, method })).toMatchObject({ ok: false, status: 503, data: { operation_outcome: 'unknown' } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it('never retries a rate-limited order submission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'Rate limited' }, 429, { 'Retry-After': '0' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRestApi({ ...options, method: 'POST', path: '/orders' })).toMatchObject({ ok: false, status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });
});

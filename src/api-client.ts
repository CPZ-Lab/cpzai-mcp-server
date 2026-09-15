/** HTTP client for the CPZ platform REST API. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// The API is mounted under the Supabase edge-function route, not /v1 alone.
const DEFAULT_API_BASE = 'https://api.cpz-lab.com/functions/v1/rest-api';
const REST_API_BASE = `${(process.env.CPZ_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, '')}/v1`;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_GET_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;

export interface ApiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  apiKey: string;
  apiSecret: string;
  requestId?: string;
  /**
   * Request budget for this call, overriding CPZ_API_TIMEOUT_MS. Discovery
   * calls use a short one so a slow API degrades the tool list rather than
   * making a client wait out the default budget.
   */
  timeoutMs?: number;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  requestId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasLogicalError(value: unknown, resource?: string): boolean {
  if (!isObject(value)) return false;
  return value.success === false || value.ok === false
    || (value.error !== undefined && value.error !== null && value.error !== false && value.error !== '')
    || (resource === 'execute' && value.hasPythonError === true)
    || (resource === 'portfolio-sync' && Array.isArray(value.results)
      && value.results.some(result => hasLogicalError(result)));
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  const backoff = 200 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
  if (retryAfter === null) return backoff;
  const value = retryAfter.trim();
  const requested = /^\d+$/.test(value)
    ? Number(value) * 1_000
    : Date.parse(value) - Date.now();
  return Number.isNaN(requested) ? backoff : Math.max(backoff, requested);
}

export async function callRestApi(opts: ApiCallOptions): Promise<ApiResult> {
  // Restrict IDs to printable header-safe tokens, also preventing log injection.
  const requestId = opts.requestId && /^[a-zA-Z0-9._:-]{1,128}$/.test(opts.requestId)
    ? opts.requestId
    : randomUUID();
  const readOnly = opts.method === 'GET';
  const resource = opts.path.split(/[/?#]/).filter(Boolean)[0] || 'unknown';
  const moneyPath = /^(orders|positions|accounts|connections|portfolio-sync|execute|risk-compute|risk-snapshots|billing|fills)$/.test(resource);

  const failure = (
    status: number,
    code: string,
    message: string,
    attempt: number,
    upstreamStatus?: number,
    upstreamData?: unknown,
    uncertain = false,
  ): ApiResult => {
    const upstream = isObject(upstreamData) ? upstreamData : {};
    if (moneyPath) {
      // No credentials, query strings, payloads or raw provider errors in logs.
      console.error('[CPZ MCP API] Request failed', {
        request_id: requestId,
        method: opts.method,
        resource,
        status,
        upstream_status: upstreamStatus,
        code,
        attempt,
        operation_outcome: uncertain ? 'unknown' : undefined,
      });
    }
    return {
      ok: false,
      status,
      requestId,
      data: {
        ...upstream,
        ...(upstream.ok !== undefined ? { ok: false, upstream_ok: upstream.ok } : {}),
        ...(upstream.success !== undefined ? { success: false, upstream_success: upstream.success } : {}),
        error: upstream.error || message,
        ...(upstream.code !== undefined ? { upstream_code: upstream.code } : {}),
        code,
        request_id: requestId,
        ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
        ...(uncertain ? {
          operation_outcome: 'unknown',
          guidance: 'The operation may have completed upstream. Check its current state before resubmitting; this client did not retry the mutation.',
        } : {}),
      },
    };
  };

  const configuredTimeout = process.env.CPZ_API_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs !== undefined
    ? opts.timeoutMs
    : configuredTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(configuredTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return failure(
      500,
      'invalid_timeout_configuration',
      opts.timeoutMs !== undefined
        ? `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`
        : `CPZ_API_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
      0,
    );
  }

  let url: URL;
  try {
    url = new URL(`${REST_API_BASE}${opts.path}`);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) url.searchParams.set(key, value);
    }
  } catch {
    return failure(500, 'invalid_api_configuration', 'The CPZ API URL could not be constructed.', 0);
  }

  let body: string | undefined;
  try {
    body = opts.body ? JSON.stringify(opts.body) : undefined;
  } catch {
    return failure(400, 'invalid_request_body', 'The request body could not be serialized as JSON.', 0);
  }

  const headers: Record<string, string> = {
    'X-CPZ-Key': opts.apiKey,
    'X-CPZ-Secret': opts.apiSecret,
    'Content-Type': 'application/json',
    'User-Agent': 'CPZ Lab (support@cpz-lab.com)',
    'x-request-id': requestId,
  };
  // One budget covers all attempts, backoff and response-body consumption.
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = readOnly ? MAX_GET_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return failure(504, 'upstream_timeout', `The ${timeoutMs}ms CPZ API request budget expired before another attempt could start.`, attempt);
    }
    let result: ApiResult;
    let transient = false;
    let retryAfter: string | null = null;
    let response: Response | undefined;
    try {
      response = await fetch(url.toString(), {
        method: opts.method,
        headers,
        body,
        signal: AbortSignal.timeout(remainingMs),
      });
      retryAfter = response.headers.get('retry-after');
      transient = response.status === 429 || response.status >= 500;
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
        result = failure(
          response.ok ? 502 : response.status,
          'invalid_upstream_response',
          'The CPZ API returned invalid JSON. No valid result is available.',
          attempt,
          response.status,
          undefined,
          !readOnly,
        );
        // Non-JSON 429/5xx responses still qualify for safe GET retries.
        if (readOnly && transient && attempt < maxAttempts) {
          const waitMs = retryDelay(retryAfter, attempt);
          if (waitMs <= MAX_RETRY_DELAY_MS && waitMs < deadline - Date.now()) {
            await delay(waitMs);
            continue;
          }
        }
        return result;
      }
      if (response.ok && !hasLogicalError(parsed, resource)) {
        return { ok: true, status: response.status, data: parsed, requestId };
      }
      result = failure(
        response.ok ? 502 : response.status,
        response.ok ? 'upstream_logical_error' : 'upstream_http_error',
        response.ok
          ? resource === 'execute' && isObject(parsed) && parsed.hasPythonError === true
            ? 'Strategy execution reported a Python error. Inspect execution_id and body for details.'
            : resource === 'portfolio-sync'
              ? 'Portfolio synchronization reported a failure. Inspect results for per-account outcomes.'
              : 'The CPZ API reported an unsuccessful operation.'
          : `The CPZ API returned HTTP ${response.status}.`,
        attempt,
        response.status,
        parsed,
        !readOnly && (response.ok || response.status >= 500),
      );
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      transient = !timedOut;
      result = failure(
        timedOut ? 504 : 502,
        timedOut ? 'upstream_timeout' : 'upstream_network_error',
        timedOut
          ? `The CPZ API did not return a complete response within the ${timeoutMs}ms request budget.`
          : 'The CPZ API response could not be received because of a network failure.',
        attempt,
        response?.status,
        undefined,
        !readOnly,
      );
    }

    if (!readOnly || !transient || attempt === maxAttempts) return result;
    const waitMs = retryDelay(retryAfter, attempt);
    // Never retry earlier than Retry-After. Long vendor delays are surfaced to
    // the caller instead of holding an MCP request open or violating backoff.
    if (waitMs > MAX_RETRY_DELAY_MS || waitMs >= deadline - Date.now()) return result;
    await delay(waitMs);
  }
  throw new Error('Unreachable: every API attempt returns a result or retries.');
}

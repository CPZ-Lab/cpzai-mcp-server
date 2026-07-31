/**
 * HTTP client for the CPZ platform REST API.
 *
 * The MCP server authenticates with the user's CPZ API key/secret and proxies
 * tool calls to the REST API. Set CPZ_API_BASE_URL to override the default endpoint
 * (useful for local development against a staging environment).
 */

// api.cpz-lab.com is a CNAME onto the Supabase project, so the REST API is only
// reachable under the edge-function mount: /functions/v1/rest-api/v1/{resource}.
// The old default (https://api.cpz-lab.com/v1) skipped that mount and got
// Supabase's gateway 404 ({"error":"requested path is invalid"}) for EVERY call
// — which the OAuth consent handler surfaced as "Invalid API credentials", so
// the keyless sign-in could never succeed no matter what the key was.
const DEFAULT_API_BASE = 'https://api.cpz-lab.com/functions/v1/rest-api';

const REST_API_BASE = `${(process.env.CPZ_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, '')}/v1`;

// No request may hang forever. fetch() without a signal waits indefinitely, so a
// stalled upstream would pin an OAuth sign-in or a tool call open with no error
// — the user just watches a spinner. Fail loudly instead.
const REQUEST_TIMEOUT_MS = parseInt(process.env.CPZ_API_TIMEOUT_MS || '20000', 10);

export interface ApiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  apiKey: string;
  apiSecret: string;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function callRestApi(opts: ApiCallOptions): Promise<ApiResult> {
  const url = new URL(`${REST_API_BASE}${opts.path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    'X-CPZ-Key': opts.apiKey,
    'X-CPZ-Secret': opts.apiSecret,
    'Content-Type': 'application/json',
  };

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      data: {
        error: timedOut
          ? `The CPZ API did not respond within ${REQUEST_TIMEOUT_MS}ms. The call did NOT complete — do not treat this as an empty result.`
          : `Could not reach the CPZ API: ${err instanceof Error ? err.message : String(err)}. The call did NOT complete — do not treat this as an empty result.`,
      },
    };
  }

  // An unparseable body is a HARD failure — never paper over it with the
  // upstream status. If we returned ok:true here, a caller (e.g. list_positions)
  // could read a parse failure as an empty-but-successful result and conclude
  // "no positions" when the truth is "we don't know". Fail loudly instead.
  const PARSE_FAILED = Symbol('parse_failed');
  const parsed: unknown = await resp.json().catch(() => PARSE_FAILED);
  if (parsed === PARSE_FAILED) {
    return {
      ok: false,
      status: resp.status,
      data: {
        error: 'Upstream response could not be parsed as JSON. The call did NOT return valid data — do not treat this as an empty result.',
        upstream_status: resp.status,
      },
    };
  }
  return { ok: resp.ok, status: resp.status, data: parsed };
}

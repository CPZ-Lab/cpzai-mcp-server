/**
 * HTTP client for the CPZ platform REST API.
 *
 * The MCP server authenticates with the user's CPZ API key/secret and proxies
 * tool calls to the REST API. Set CPZ_API_BASE_URL to override the default endpoint
 * (useful for local development against a staging environment).
 */

const REST_API_BASE = process.env.CPZ_API_BASE_URL
  ? `${process.env.CPZ_API_BASE_URL.replace(/\/$/, '')}/v1`
  : 'https://api.cpz-lab.com/v1';

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

  const resp = await fetch(url.toString(), {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

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

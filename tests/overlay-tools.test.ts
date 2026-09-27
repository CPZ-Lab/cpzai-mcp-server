import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Request as ExpressRequest } from 'express';

const OVERLAY = '5a5d40e6-53f9-4be6-9ebc-d0f83a7f1b71';
const OVERLAY_B = '96043206-24a4-4d63-9cd7-04c51ccf7d7c';
const OVERLAY_C = '0b8f3c52-6a1e-4d2b-9f41-2c7e8d9a0b13';
const ALPHA = '123e4567-e89b-42d3-a456-426614174000';
const HEADERS = { 'x-cpz-key': 'test-key', 'x-cpz-secret': 'test-secret', 'x-request-id': 'overlay-test' };

const REST = 'https://api.example.test/functions/v1/rest-api/v1';
const GATEWAY = 'https://gateway.example.test/cpz';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A complete beta exposure document, shaped like the gateway's. */
function exposureDoc(id: string, overrides: Record<string, unknown> = {}, hedge: Record<string, unknown> = {}) {
  return {
    overlay_strategy_id: id,
    overlay_title: 'SPY beta hedge',
    as_of: '2026-09-27T10:00:00.000Z',
    complete: true,
    benchmark_symbol: 'SPY',
    targets: [
      { kind: 'strategy', strategy_id: ALPHA, account_key: null, broker: null, environment: null, weight: 1, source: 'strategy_lots', positions_as_of: null, legs: [], net_notional: 10000, gross_notional: 10000, beta_dollars: 12000 },
      { kind: 'account', strategy_id: null, account_key: 'PA123', broker: 'alpaca', environment: 'paper', weight: 0.5, source: 'broker_positions', positions_as_of: '2026-09-27T09:55:00.000Z', legs: [], net_notional: 4000, gross_notional: 4000, beta_dollars: 4000 },
    ],
    target_total: { net_notional: 14000, gross_notional: 14000, beta_dollars: 16000, by_symbol: {} },
    overlay: { net_notional: -12000, gross_notional: 12000, beta_dollars: -12000, by_symbol: {}, legs: [] },
    combined: { net_notional: 2000, gross_notional: 26000, beta_dollars: 4000, by_symbol: {} },
    hedge: {
      objective: 'beta', target_ratio: 1, tolerance_band: 0.1,
      current_ratio: 0.75, drift: 0.25, outside_band: true, reason: null,
      suggested_order: { symbol: 'SPY', side: 'sell', qty: 6.1, notional: 4000 }, vol: null,
      ...hedge,
    },
    effectiveness: { target_vol_usd: 2000, combined_vol_usd: 600, vol_reduction: 0.7, lookback_days: 250 },
    missing_prices: [],
    missing_history: [],
    warnings: [],
    ...overrides,
  };
}

const incompleteHedge = {
  current_ratio: null, drift: null, outside_band: null, suggested_order: null,
  reason: 'incomplete: no price for XYZ',
};

function strategyRow(id: string, role: 'alpha' | 'overlay', extra: Record<string, unknown> = {}) {
  return {
    id, user_id: 'u1', title: `Strategy ${id.slice(0, 4)}`, status: 'active', strategy_type: 'momentum',
    strategy_role: role, allow_short: role === 'overlay', python_code: 'print("secret sauce")',
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', ...extra,
  };
}

function structured(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

describe('overlay tools over MCP', () => {
  let client: Client;
  let server: McpServer;
  let routes: Handler[];
  let fetchMock: ReturnType<typeof vi.fn>;

  function on(handler: Handler) {
    routes.push(handler);
  }

  function calls(prefix: string) {
    return fetchMock.mock.calls
      .map(([raw, init]) => ({ url: new URL(String(raw)), init: init as RequestInit }))
      .filter(call => call.url.toString().startsWith(prefix));
  }

  beforeEach(async () => {
    vi.stubEnv('CPZ_API_BASE_URL', 'https://api.example.test/functions/v1/rest-api');
    vi.stubEnv('CPZ_GATEWAY_BASE_URL', GATEWAY);
    vi.stubEnv('CPZ_API_TIMEOUT_MS', '20000');
    vi.resetModules();
    routes = [];
    fetchMock = vi.fn(async (raw: string | URL, init: RequestInit) => {
      const url = new URL(String(raw));
      for (const handler of routes) {
        const response = await handler(url, init);
        if (response) return response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { registerOverlayTools } = await import('../src/overlay-tools.js');
    server = new McpServer({ name: 'overlay-test', version: '1.0.0' });
    registerOverlayTools(server, { apiKey: 'test-key', apiSecret: 'test-secret', requestId: 'overlay-test' });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('advertises both tools as read-only and idempotent, and no write tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(['get_overlay_exposure', 'list_overlays']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
  });

  describe('get_overlay_exposure', () => {
    it('reads the gateway route with the caller credential and leads with the verdict', async () => {
      const doc = exposureDoc(OVERLAY);
      on(() => json(doc));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).not.toBe(true);

      const [call] = calls(GATEWAY);
      expect(call.url.origin + call.url.pathname).toBe(`${GATEWAY}/overlay/exposure`);
      expect(Object.fromEntries(call.url.searchParams)).toEqual({ strategy_id: OVERLAY });
      expect(call.init.method).toBe('GET');
      expect(call.init.headers).toMatchObject({ 'X-CPZ-Key': 'test-key', 'X-CPZ-Secret': 'test-secret', 'x-request-id': 'overlay-test' });
      expect(call.init.body).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const body = structured(result);
      expect(body).toEqual({ complete: true, hedge_ratio_status: 'measured', hedge_ratio_reason: null, data: doc });
      expect(Object.keys(body)[0]).toBe('complete');
      expect(body.withheld).toBeUndefined();
    });

    it('withholds the ratio on an incomplete book and says why, before the numbers', async () => {
      on(() => json(exposureDoc(OVERLAY, { complete: false, missing_prices: ['XYZ'], missing_history: ['ABC'] }, incompleteHedge)));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).not.toBe(true);
      const body = structured(result);
      expect(body.complete).toBe(false);
      expect(body.hedge_ratio_status).toBe('withheld');
      expect(body.hedge_ratio_reason).toBe('incomplete: no price for XYZ');
      expect(body.withheld).toMatchObject({
        fields: ['hedge.current_ratio', 'hedge.drift', 'hedge.outside_band', 'hedge.suggested_order'],
        missing_prices: ['XYZ'],
        missing_history: ['ABC'],
      });
      expect(body.withheld.guidance).toContain('Do not size or place a hedge');
      for (const field of ['current_ratio', 'drift', 'outside_band', 'suggested_order']) {
        expect(body.data.hedge[field]).toBeNull();
      }
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text.indexOf('"complete": false')).toBeLessThan(text.indexOf('"data"'));
    });

    it('never presents a number the platform marked incomplete, and logs the drift', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      on(() => json(exposureDoc(OVERLAY, { complete: false, missing_prices: ['XYZ'] }, { current_ratio: 0.4, drift: 0.6 })));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      const body = structured(result);
      expect(body.hedge_ratio_status).toBe('withheld');
      expect(body.data.hedge.current_ratio).toBeNull();
      expect(body.data.hedge.drift).toBeNull();
      expect(body.data.hedge.suggested_order).toBeNull();
      expect(JSON.stringify(result.content)).not.toContain('0.4');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('incomplete exposure carried hedge values'),
        expect.objectContaining({ strategy_id: OVERLAY, fields: ['current_ratio', 'drift', 'outside_band', 'suggested_order'] }),
      );
    });

    it('reports an objective with no ratio as not measured, not as zero', async () => {
      on(() => json(exposureDoc(OVERLAY, {}, {
        objective: 'tail', current_ratio: null, drift: null, outside_band: null, suggested_order: null,
        reason: 'tail hedges are sized to a payoff, not a ratio; exposure only',
      })));
      const body = structured(await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } }));
      expect(body.complete).toBe(true);
      expect(body.hedge_ratio_status).toBe('not_measured');
      expect(body.hedge_ratio_reason).toContain('tail hedges');
    });

    it('surfaces a 404 as an error without retrying it', async () => {
      on(() => json({ error: 'overlay_not_found', message: 'no strategy with this id belongs to the caller', overlay_strategy_id: OVERLAY }, 404));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ error: 'overlay_not_found', upstream_status: 404, code: 'upstream_http_error' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['not_an_overlay', 'overlay_not_configured'])('surfaces a 409 %s with guidance this server can honour', async (code) => {
      on(() => json({ error: code, message: 'set it up in the Overlay tab or with save_overlay_config' }, 409));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).toBe(true);
      const body = structured(result);
      expect(body).toMatchObject({ error: code, upstream_status: 409 });
      expect(body.guidance).toContain('Strategy Lab');
      expect(body.guidance).toContain('no overlay write tool');
    });

    it('surfaces a 503 when the platform has no market data', async () => {
      on(() => json({ error: 'market_data_unconfigured', message: 'no platform market-data source is configured in this runtime' }, 503));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ error: 'market_data_unconfigured', upstream_status: 503 });
    });

    it('surfaces an insufficient-scope refusal from the gateway', async () => {
      on(() => json({ error: 'insufficient_scope', message: 'overlay/exposure needs the strategies scope' }, 403));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ error: 'insufficient_scope', upstream_status: 403 });
    });

    it('refuses a 200 that carries no completeness verdict', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { complete: _complete, ...doc } = exposureDoc(OVERLAY);
      on(() => json(doc));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ code: 'invalid_upstream_response' });
      expect(JSON.stringify(result.content)).not.toContain('0.75');
    });

    it.each(['../overlay', 'not-a-uuid', ''])('rejects the strategy id %j before any HTTP', async (strategy_id) => {
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id } });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('list_overlays', () => {
    function strategies(pages: Array<Array<Record<string, unknown>>>) {
      on(url => {
        if (!url.toString().startsWith(`${REST}/strategies`)) return undefined as unknown as Response;
        const offset = Number(url.searchParams.get('offset'));
        return json({ data: pages[offset / 100] ?? [], count: (pages[offset / 100] ?? []).length });
      });
    }

    function exposures(byId: Record<string, Response | (() => Response)>) {
      on(url => {
        if (!url.toString().startsWith(`${GATEWAY}/overlay/exposure`)) return undefined as unknown as Response;
        const entry = byId[url.searchParams.get('strategy_id') ?? ''];
        if (!entry) throw new Error(`no exposure fixture for ${url}`);
        return typeof entry === 'function' ? entry() : entry.clone();
      });
    }

    it('scans every strategy page, keeps overlays only, and reads each configuration', async () => {
      const first = Array.from({ length: 100 }, (_, i) => strategyRow(
        i === 0 ? OVERLAY : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i === 0 ? 'overlay' : 'alpha'));
      strategies([first, [strategyRow(OVERLAY_B, 'overlay'), strategyRow(ALPHA, 'alpha')]]);
      exposures({
        [OVERLAY]: json(exposureDoc(OVERLAY)),
        [OVERLAY_B]: json(exposureDoc(OVERLAY_B, { complete: false, missing_prices: ['XYZ'] }, incompleteHedge)),
      });

      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).not.toBe(true);

      const scans = calls(`${REST}/strategies`);
      expect(scans.map(call => Object.fromEntries(call.url.searchParams))).toEqual([
        { limit: '100', offset: '0', sort_by: 'created_at', sort_order: 'asc' },
        { limit: '100', offset: '100', sort_by: 'created_at', sort_order: 'asc' },
      ]);
      expect(scans.every(call => call.init.method === 'GET')).toBe(true);
      expect(calls(GATEWAY).map(call => call.url.searchParams.get('strategy_id')).sort()).toEqual([OVERLAY, OVERLAY_B].sort());

      const body = structured(result);
      expect(body).toMatchObject({ count: 2, total: 2, offset: 0, limit: 10 });
      expect(body.unavailable_policy_fields).toEqual(['hedge_instruments', 'rebalance_trigger', 'notes']);
      const [a, b] = body.data;
      expect(a).toMatchObject({
        strategy_id: OVERLAY, status: 'active', allow_short: true, configured: true,
        policy: { objective: 'beta', hedge_ratio: 1, tolerance_band: 0.1, benchmark_symbol: 'SPY' },
        hedge: { complete: true, hedge_ratio_status: 'measured', current_ratio: 0.75, outside_band: true },
      });
      expect(a.targets).toEqual([
        { kind: 'strategy', strategy_id: ALPHA, account_key: null, broker: null, environment: null, weight: 1 },
        { kind: 'account', strategy_id: null, account_key: 'PA123', broker: 'alpaca', environment: 'paper', weight: 0.5 },
      ]);
      expect(b.hedge).toMatchObject({ complete: false, hedge_ratio_status: 'withheld', current_ratio: null, drift: null, outside_band: null });
      // Stored strategy code never rides along in a list of overlays.
      expect(JSON.stringify(result.content)).not.toContain('secret sauce');
    });

    it('reports an overlay with no policy or targets as unconfigured, not as a failure', async () => {
      strategies([[strategyRow(OVERLAY, 'overlay')]]);
      exposures({ [OVERLAY]: json({ error: 'overlay_not_configured', message: 'the overlay has no targets yet' }, 409) });
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(structured(result).data[0]).toMatchObject({
        strategy_id: OVERLAY, configured: false, policy: null, targets: null, note: 'the overlay has no targets yet',
      });
    });

    it('fails the page when a configuration cannot be read, keeping every entry', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      strategies([[strategyRow(OVERLAY, 'overlay'), strategyRow(OVERLAY_B, 'overlay')]]);
      exposures({
        [OVERLAY]: json(exposureDoc(OVERLAY)),
        [OVERLAY_B]: () => json({ error: 'ledger_read_failed', message: 'position_lots: timeout' }, 502),
      });
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).toBe(true);
      const body = structured(result);
      expect(body.code).toBe('overlay_read_failed');
      expect(body.error).toContain('1 of 2 overlays');
      expect(body.error).toContain('unknown, not empty');
      expect(body.data[0]).toMatchObject({ strategy_id: OVERLAY, configured: true });
      expect(body.data[1]).toMatchObject({
        strategy_id: OVERLAY_B, configured: null, policy: null, targets: null,
        error: { status: 502, error: 'ledger_read_failed', message: 'position_lots: timeout' },
      });
    });

    it('pages over overlays and reads only the requested ones', async () => {
      strategies([[strategyRow(OVERLAY, 'overlay'), strategyRow(ALPHA, 'alpha'), strategyRow(OVERLAY_B, 'overlay'), strategyRow(OVERLAY_C, 'overlay')]]);
      exposures({ [OVERLAY_B]: json(exposureDoc(OVERLAY_B)) });
      const result = await client.callTool({ name: 'list_overlays', arguments: { limit: 1, offset: 1 } });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toMatchObject({ count: 1, total: 3, offset: 1, limit: 1 });
      expect(structured(result).data.map((entry: { strategy_id: string }) => entry.strategy_id)).toEqual([OVERLAY_B]);
      expect(calls(GATEWAY)).toHaveLength(1);
    });

    it('returns an empty page when the caller has no overlays, without reading exposure', async () => {
      strategies([[strategyRow(ALPHA, 'alpha')]]);
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toMatchObject({ data: [], count: 0, total: 0 });
      expect(calls(GATEWAY)).toHaveLength(0);
    });

    it('refuses to guess when the platform does not report strategy_role', async () => {
      const { strategy_role: _role, ...row } = strategyRow(ALPHA, 'alpha');
      strategies([[row]]);
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result).code).toBe('strategy_role_unavailable');
      expect(calls(GATEWAY)).toHaveLength(0);
    });

    it('refuses a scan it cannot complete instead of listing part of it', async () => {
      const full = Array.from({ length: 100 }, (_, i) => strategyRow(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'alpha'));
      on(url => url.toString().startsWith(`${REST}/strategies`) ? json({ data: full, count: 100 }) : undefined as unknown as Response);
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result).code).toBe('strategy_scan_too_large');
      expect(calls(`${REST}/strategies`)).toHaveLength(20);
    });

    it('surfaces a strategies scope refusal from the REST API', async () => {
      on(() => json({ error: 'Insufficient scope for "strategies". Requires one of: strategies' }, 403));
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ upstream_status: 403 });
      expect(calls(GATEWAY)).toHaveLength(0);
    });

    it.each([{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { offset: -1 }])('rejects invalid paging %j before any HTTP', async (args) => {
      const result = await client.callTool({ name: 'list_overlays', arguments: args });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('overlay tools and credential scopes', () => {
  beforeEach(() => {
    vi.stubEnv('CPZ_GATEWAY_BASE_URL', GATEWAY);
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [], count: 0 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function connect(options: { mode?: 'full' | 'compact'; scopes?: Set<string> | null }) {
    const { createMcpServer } = await import('../src/server.js');
    const server = createMcpServer({ headers: HEADERS } as unknown as ExpressRequest, options);
    const client = new Client({ name: 'scope-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  }

  it('maps both tools to the strategies scope', async () => {
    const { TOOL_SCOPES } = await import('../src/scopes.js');
    expect(TOOL_SCOPES.get_overlay_exposure).toEqual(['strategies']);
    expect(TOOL_SCOPES.list_overlays).toEqual(['strategies']);
  });

  it('advertises them to a strategies key and hides them from a data or trading key', async () => {
    for (const [scopes, visible] of [
      [new Set(['strategies']), true],
      [new Set(['data']), false],
      [new Set(['orders', 'trading_credentials']), false],
    ] as const) {
      const { server, client } = await connect({ scopes: new Set(scopes) });
      const names = (await client.listTools()).tools.map(tool => tool.name);
      for (const name of ['get_overlay_exposure', 'list_overlays']) expect(names.includes(name), `${name} ${[...scopes]}`).toBe(visible);
      await client.close();
      await server.close();
    }
  });

  it('defers them in compact mode, finds them by search, and dispatches the read through call_tool', async () => {
    const fetchMock = vi.fn(async () => json(exposureDoc(OVERLAY)));
    vi.stubGlobal('fetch', fetchMock);
    const { server, client } = await connect({ mode: 'compact', scopes: new Set(['strategies']) });
    const advertised = (await client.listTools()).tools.map(tool => tool.name);
    expect(advertised).not.toContain('get_overlay_exposure');
    expect(advertised).not.toContain('list_overlays');

    const search = await client.callTool({ name: 'search_tools', arguments: { query: 'overlay hedge exposure' } });
    const found = structured(search).tools.map((tool: { name: string }) => tool.name);
    expect(found).toEqual(expect.arrayContaining(['get_overlay_exposure', 'list_overlays']));

    const dispatched = await client.callTool({ name: 'call_tool', arguments: { name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } } });
    expect(dispatched.isError).not.toBe(true);
    expect(structured(dispatched).complete).toBe(true);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${GATEWAY}/overlay/exposure?strategy_id=${OVERLAY}`);
    await client.close();
    await server.close();
  });

  it('will not dispatch them for a key without the strategies scope', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { server, client } = await connect({ mode: 'compact', scopes: new Set(['data']) });
    const dispatched = await client.callTool({ name: 'call_tool', arguments: { name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } } });
    expect(dispatched.isError).toBe(true);
    expect(structured(dispatched).code).toBe('unknown_tool');
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});

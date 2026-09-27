import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Request as ExpressRequest } from 'express';

const OVERLAY = '5a5d40e6-53f9-4be6-9ebc-d0f83a7f1b71';
const OVERLAY_B = '96043206-24a4-4d63-9cd7-04c51ccf7d7c';
const ALPHA = '123e4567-e89b-42d3-a456-426614174000';
const HEADERS = { 'x-cpz-key': 'test-key', 'x-cpz-secret': 'test-secret', 'x-request-id': 'overlay-test' };

const GATEWAY = 'https://gateway.example.test/cpz';

type Handler = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;

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

/** An OverlayConfigDoc, shaped like the gateway's GET /overlays entries. */
function configDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    strategy_id: id,
    title: 'SPY beta hedge',
    status: 'active',
    role: 'overlay',
    allow_short: true,
    configured: true,
    policy: {
      objective: 'beta', hedge_ratio: 1, tolerance_band: 0.1, hedge_instruments: ['SPY'],
      benchmark_symbol: 'SPY', rebalance_trigger: 'band', notes: 'hedge the momentum book',
      updated_at: '2026-09-27T10:00:00Z',
    },
    targets: [
      { kind: 'strategy', strategy_id: ALPHA, weight: 1 },
      { kind: 'account', account_key: 'PA123', broker: 'alpaca', environment: 'paper', weight: 0.5 },
    ],
    ...overrides,
  };
}

const betaPolicy = { objective: 'beta', hedge_ratio: 0.8, tolerance_band: 0.05, benchmark_symbol: 'spy', hedge_instruments: ['spy', 'ivv'], rebalance_trigger: 'band', notes: 'half the book' };
const targets = [
  { kind: 'strategy', strategy_id: ALPHA, weight: 1 },
  { kind: 'account', account_key: 'PA123', broker: 'alpaca', environment: 'paper' },
];

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

  it('advertises the two reads as read-only and configure_overlay as a destructive write', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(['configure_overlay', 'get_overlay_exposure', 'list_overlays']);
    for (const tool of tools.filter(tool => tool.name !== 'configure_overlay')) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    const configure = tools.find(tool => tool.name === 'configure_overlay');
    expect(configure?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
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

    it.each(['not_an_overlay', 'overlay_not_configured'])('surfaces a 409 %s pointing at configure_overlay', async (code) => {
      on(() => json({ error: code, message: 'set it up in the Overlay tab or with save_overlay_config' }, 409));
      const result = await client.callTool({ name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } });
      expect(result.isError).toBe(true);
      const body = structured(result);
      expect(body).toMatchObject({ error: code, upstream_status: 409 });
      expect(body.guidance).toContain('configure_overlay');
      expect(body.guidance).toContain('list_overlays');
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
    it('reads every overlay configuration in one gateway call', async () => {
      const overlays = [configDoc(OVERLAY), configDoc(OVERLAY_B, { configured: false, policy: null, targets: [] })];
      on(() => json({ overlays, truncated: false }));
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).not.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [call] = calls(GATEWAY);
      expect(call.url.toString()).toBe(`${GATEWAY}/overlays`);
      expect(call.init.method).toBe('GET');
      expect(call.init.headers).toMatchObject({ 'X-CPZ-Key': 'test-key', 'X-CPZ-Secret': 'test-secret', 'x-request-id': 'overlay-test' });

      const body = structured(result);
      expect(body).toEqual({ data: overlays, count: 2, truncated: false });
      expect(body.data[0].policy).toMatchObject({ hedge_instruments: ['SPY'], rebalance_trigger: 'band', notes: 'hedge the momentum book' });
    });

    it('returns an empty list as an empty list', async () => {
      on(() => json({ overlays: [], truncated: false }));
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toEqual({ data: [], count: 0, truncated: false });
    });

    it('says plainly when the platform truncated the list', async () => {
      on(() => json({ overlays: [configDoc(OVERLAY)], truncated: true }));
      const body = structured(await client.callTool({ name: 'list_overlays', arguments: {} }));
      expect(body.truncated).toBe(true);
      expect(body.note).toContain('not the complete list');
    });

    it.each([
      [{ truncated: false }],
      [{ overlays: {}, truncated: false }],
      [{ overlays: [] }],
      [[]],
    ])('refuses a 200 it cannot read as the overlay list: %j', async (payload) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      on(() => json(payload));
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result).code).toBe('invalid_upstream_response');
    });

    it.each([
      [502, 'overlay_read_failed'],
      [403, 'insufficient_scope'],
    ])('surfaces a %i %s as an error', async (status, code) => {
      on(() => json({ error: code, message: 'upstream said no' }, status));
      const result = await client.callTool({ name: 'list_overlays', arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ error: code, upstream_status: status, message: 'upstream said no' });
    });
  });

  describe('configure_overlay', () => {
    function putCalls() {
      return calls(`${GATEWAY}/overlays/`).filter(call => call.init.method === 'PUT');
    }

    it('saves role, policy and targets with one PUT and returns the saved configuration', async () => {
      const saved = { strategy_id: OVERLAY, role: 'overlay', targets: 2 };
      on(() => json({ saved, overlay: configDoc(OVERLAY) }));
      const result = await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets },
      });
      expect(result.isError).not.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [call] = putCalls();
      expect(call.url.toString()).toBe(`${GATEWAY}/overlays/${OVERLAY}`);
      expect(call.init.headers).toMatchObject({ 'X-CPZ-Key': 'test-key', 'X-CPZ-Secret': 'test-secret', 'x-request-id': 'overlay-test' });
      expect(JSON.parse(String(call.init.body))).toEqual({
        role: 'overlay',
        // Symbols are sent upper-case, as the database stores them.
        policy: { ...betaPolicy, benchmark_symbol: 'SPY', hedge_instruments: ['SPY', 'IVV'] },
        targets,
      });
      expect(structured(result)).toEqual({ saved, overlay: configDoc(OVERLAY) });
    });

    it('sends role alpha alone to remove the configuration', async () => {
      on(() => json({ saved: { strategy_id: OVERLAY, role: 'alpha', targets: 0 }, overlay: configDoc(OVERLAY, { role: 'alpha', configured: false, policy: null, targets: [] }) }));
      const result = await client.callTool({ name: 'configure_overlay', arguments: { strategy_id: OVERLAY, role: 'alpha' } });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(String(putCalls()[0].init.body))).toEqual({ role: 'alpha' });
    });

    it('sends only the policy fields given, so the database defaults are its own', async () => {
      on(() => json({ saved: { strategy_id: OVERLAY, role: 'overlay', targets: 1 }, overlay: configDoc(OVERLAY) }));
      await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: { objective: 'tail' }, targets: [targets[0]] },
      });
      expect(JSON.parse(String(putCalls()[0].init.body)).policy).toEqual({ objective: 'tail' });
    });

    it('reports a save whose read-back failed as saved, and says it is unconfirmed', async () => {
      on(() => json({ saved: { strategy_id: OVERLAY, role: 'overlay', targets: 2 }, overlay: null, read_back_error: { error: 'overlay_read_failed' } }));
      const result = await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets },
      });
      expect(result.isError).not.toBe(true);
      const body = structured(result);
      expect(body.saved).toMatchObject({ role: 'overlay' });
      expect(body.overlay).toBeNull();
      expect(body.read_back_error).toEqual({ error: 'overlay_read_failed' });
      expect(body.note).toContain('saved');
      expect(body.note).toContain('list_overlays');
    });

    it('surfaces the platform 400 message verbatim', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = 'overlay 5a5d40e6 cannot target 123e4567 : that target already (transitively) hedges this overlay';
      on(() => json({ error: 'invalid_overlay_config', message }, 400));
      const result = await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ error: 'invalid_overlay_config', message, upstream_status: 400 });
      expect(structured(result).operation_outcome).toBeUndefined();
      expect((result.content as Array<{ text: string }>)[0].text).toContain(message);
    });

    it.each([
      [404, 'not_found_or_not_owned'],
      [409, 'duplicate_target'],
      [403, 'insufficient_scope'],
    ])('surfaces a %i %s as an error', async (status, code) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      on(() => json({ error: code, message: 'refused' }, status));
      const result = await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ error: code, upstream_status: status });
    });

    it('never retries a failed save and marks its outcome unknown', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      on(() => json({ error: 'overlay_save_failed', message: 'statement timeout' }, 502));
      const result = await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets },
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(structured(result)).toMatchObject({ error: 'overlay_save_failed', upstream_status: 502, operation_outcome: 'unknown' });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('configure_overlay failed'),
        expect.objectContaining({ strategy_id: OVERLAY, status: 502, error: 'overlay_save_failed' }),
      );
    });

    it('does not call an unreadable 200 a save', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      on(() => json({ ok_maybe: true }));
      const result = await client.callTool({
        name: 'configure_overlay',
        arguments: { strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({ code: 'invalid_upstream_response', operation_outcome: 'unknown' });
    });

    const overlay = (patch: Record<string, unknown>) => ({ strategy_id: OVERLAY, role: 'overlay', policy: betaPolicy, targets, ...patch });

    it.each([
      ['an overlay with no policy', overlay({ policy: undefined }), 'needs a policy'],
      ['an overlay with no targets', overlay({ targets: undefined }), 'at least one target'],
      ['an overlay with an empty target list', overlay({ targets: [] }), 'at least one target'],
      ['a beta overlay with no benchmark', overlay({ policy: { objective: 'beta', hedge_ratio: 1 } }), 'benchmark_symbol'],
      ['an overlay targeting itself', overlay({ targets: [{ kind: 'strategy', strategy_id: OVERLAY.toUpperCase() }] }), 'cannot target itself'],
      ['the same strategy twice', overlay({ targets: [targets[0], { ...targets[0], weight: 2 }] }), 'listed twice'],
      ['the same account twice', overlay({ targets: [targets[1], { ...targets[1], broker: ' Alpaca ', account_key: 'PA123 ' }] }), 'listed twice'],
      ['role alpha with a policy', { strategy_id: OVERLAY, role: 'alpha', policy: betaPolicy }, 'pass neither'],
      ['role alpha with targets', { strategy_id: OVERLAY, role: 'alpha', targets }, 'pass neither'],
    ])('refuses %s before any HTTP', async (_label, args, message) => {
      const result = await client.callTool({ name: 'configure_overlay', arguments: args as Record<string, unknown> });
      expect(result.isError).toBe(true);
      expect(structured(result).code).toBe('invalid_arguments');
      expect(structured(result).error).toContain(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown objective', overlay({ policy: { objective: 'gamma' } })],
      ['a hedge ratio above 5', overlay({ policy: { ...betaPolicy, hedge_ratio: 5.01 } })],
      ['a negative hedge ratio', overlay({ policy: { ...betaPolicy, hedge_ratio: -0.1 } })],
      ['a zero tolerance band', overlay({ policy: { ...betaPolicy, tolerance_band: 0 } })],
      ['a tolerance band above 1', overlay({ policy: { ...betaPolicy, tolerance_band: 1.01 } })],
      ['an unknown rebalance trigger', overlay({ policy: { ...betaPolicy, rebalance_trigger: 'daily' } })],
      ['a misspelt policy field', overlay({ policy: { ...betaPolicy, hedge_ration: 0.5 } })],
      ['a target of unknown kind', overlay({ targets: [{ kind: 'portfolio', strategy_id: ALPHA }] })],
      ['an account with no environment', overlay({ targets: [{ kind: 'account', account_key: 'PA123', broker: 'alpaca' }] })],
      ['an account environment that is not paper or live', overlay({ targets: [{ ...targets[1], environment: 'prod' }] })],
      ['a zero weight', overlay({ targets: [{ ...targets[0], weight: 0 }] })],
      ['a weight above 10', overlay({ targets: [{ ...targets[0], weight: 10.5 }] })],
      ['a target strategy id that is not a uuid', overlay({ targets: [{ kind: 'strategy', strategy_id: '../x' }] })],
      ['an overlay id that is not a uuid', overlay({ strategy_id: '../overlays' })],
      ['an unknown role', overlay({ role: 'hedge' })],
    ])('refuses %s at the schema, before any HTTP', async (_label, args) => {
      const result = await client.callTool({ name: 'configure_overlay', arguments: args as Record<string, unknown> });
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

  const OVERLAY_TOOLS = ['get_overlay_exposure', 'list_overlays', 'configure_overlay'];

  it('maps every overlay tool to the strategies scope', async () => {
    const { TOOL_SCOPES } = await import('../src/scopes.js');
    for (const name of OVERLAY_TOOLS) expect(TOOL_SCOPES[name], name).toEqual(['strategies']);
  });

  it('advertises them to a strategies key and hides them from a data or trading key', async () => {
    for (const [scopes, visible] of [
      [new Set(['strategies']), true],
      [new Set(['data']), false],
      [new Set(['orders', 'trading_credentials']), false],
    ] as const) {
      const { server, client } = await connect({ scopes: new Set(scopes) });
      const names = (await client.listTools()).tools.map(tool => tool.name);
      for (const name of OVERLAY_TOOLS) expect(names.includes(name), `${name} ${[...scopes]}`).toBe(visible);
      await client.close();
      await server.close();
    }
  });

  it('in compact mode advertises configure_overlay by name and defers the reads behind search', async () => {
    const fetchMock = vi.fn(async () => json(exposureDoc(OVERLAY)));
    vi.stubGlobal('fetch', fetchMock);
    const { server, client } = await connect({ mode: 'compact', scopes: new Set(['strategies']) });
    const advertised = (await client.listTools()).tools.map(tool => tool.name);
    expect(advertised).toContain('configure_overlay');
    expect(advertised).not.toContain('get_overlay_exposure');
    expect(advertised).not.toContain('list_overlays');

    const search = await client.callTool({ name: 'search_tools', arguments: { query: 'overlay hedge exposure' } });
    const found = structured(search).tools.map((tool: { name: string }) => tool.name);
    expect(found).toEqual(expect.arrayContaining(['get_overlay_exposure', 'list_overlays']));

    const dispatched = await client.callTool({ name: 'call_tool', arguments: { name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } } });
    expect(dispatched.isError).not.toBe(true);
    expect(structured(dispatched).complete).toBe(true);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${GATEWAY}/overlay/exposure?strategy_id=${OVERLAY}`);

    // The write is never dispatchable through the generic read path.
    const write = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'configure_overlay', arguments: { strategy_id: OVERLAY, role: 'alpha' } },
    });
    expect(write.isError).toBe(true);
    expect(structured(write).code).toBe('not_dispatchable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });

  it('will not dispatch them for a key without the strategies scope', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { server, client } = await connect({ mode: 'compact', scopes: new Set(['data']) });
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('configure_overlay');
    const dispatched = await client.callTool({ name: 'call_tool', arguments: { name: 'get_overlay_exposure', arguments: { strategy_id: OVERLAY } } });
    expect(dispatched.isError).toBe(true);
    expect(structured(dispatched).code).toBe('unknown_tool');
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});

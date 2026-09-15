import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Request } from 'express';
import { createMcpServer } from '../src/server.js';
import { clearScopeCache, isAllowed, resolveScopes, TOOL_SCOPES } from '../src/scopes.js';

const HEADERS = { 'x-cpz-key': 'test-key', 'x-cpz-secret': 'test-secret', 'x-request-id': 'mcp-test' };

async function toolNames(options: { mode?: 'full' | 'compact'; scopes?: Set<string> | null }) {
  const server = createMcpServer({ headers: HEADERS } as unknown as Request, options);
  const client = new Client({ name: 'scope-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  await client.close();
  await server.close();
  return names;
}

describe('scope-aware discovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearScopeCache();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearScopeCache();
  });

  it('advertises only what a data-scoped key can call', async () => {
    const names = await toolNames({ scopes: new Set(['data']) });
    expect(names).toEqual([
      'list_data_files', 'get_data_file', 'list_connections', 'create_connection',
      'get_market_data', 'get_bars', 'list_webhooks', 'create_webhook', 'delete_webhook', 'get_profile',
    ]);
    // The tools that would 403 are gone, including the whole order surface.
    for (const gone of ['place_order', 'list_orders', 'list_positions', 'list_strategies', 'list_cash_flows']) {
      expect(names).not.toContain(gone);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the trading surface for a trade-scoped key', async () => {
    const names = await toolNames({ scopes: new Set(['orders', 'trading_credentials']) });
    expect(names).toContain('place_order');
    expect(names).toContain('list_positions');
    expect(names).toContain('list_cash_flows');
    expect(names).not.toContain('list_strategies');
    expect(names).not.toContain('get_bars');
  });

  it('advertises the full catalogue when scopes are unknown, which is not the same as none', async () => {
    expect(await toolNames({ scopes: null })).toHaveLength(31);
    expect(await toolNames({})).toHaveLength(31);
    // An identity-only credential holds no resource scope and gets only the
    // tools that need none.
    expect(await toolNames({ scopes: new Set<string>() })).toEqual(['get_profile']);
  });

  it('hides out-of-scope tools from search and dispatch in compact mode', async () => {
    const server = createMcpServer({ headers: HEADERS } as unknown as Request, {
      mode: 'compact',
      scopes: new Set(['data']),
    });
    const client = new Client({ name: 'scope-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const search = await client.callTool({ name: 'search_tools', arguments: { query: 'cash flows settlement' } });
    expect((search as { structuredContent: { count: number } }).structuredContent.count).toBe(0);

    const dispatch = await client.callTool({ name: 'call_tool', arguments: { name: 'list_cash_flows' } });
    expect((dispatch as { isError?: boolean }).isError).toBe(true);
    expect((dispatch as { structuredContent: { code: string } }).structuredContent.code).toBe('unknown_tool');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it('every tool that maps to a scope names one the REST API recognizes', async () => {
    const vocabulary = new Set([
      'strategies', 'data', 'orders', 'trading_credentials', 'data_connections', 'storage', 'simons',
    ]);
    for (const [tool, accepted] of Object.entries(TOOL_SCOPES)) {
      expect(accepted.length, tool).toBeGreaterThan(0);
      for (const scope of accepted) expect(vocabulary, `${tool}: ${scope}`).toContain(scope);
    }
    expect(isAllowed('search_tools', new Set())).toBe(true);
    expect(isAllowed('get_profile', new Set())).toBe(true);
  });
});

describe('scope lookup', () => {
  beforeEach(() => clearScopeCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearScopeCache();
  });

  it('reads the expanded scopes from /me and caches them per credential', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { id: 'u1', scopes: ['orders', 'trading_credentials'] } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveScopes('key', 'secret', 'req-1');
    expect([...(first ?? [])].sort()).toEqual(['orders', 'trading_credentials']);
    const second = await resolveScopes('key', 'secret', 'req-2');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/me');

    // A different credential is a different cache entry.
    await resolveScopes('other-key', 'other-secret', 'req-3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null and says so loudly when the lookup fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })));
    expect(await resolveScopes('key', 'secret', 'req-4')).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/me lookup failed'), expect.objectContaining({ status: 401 }));
  });

  it('returns null against a REST API that does not yet report scopes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: { id: 'u1', email: 'a@b.c' } }),
      { status: 200 },
    )));
    expect(await resolveScopes('key', 'secret', 'req-5')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no scopes field'), expect.anything());
  });

  it('never looks up scopes without both halves of a credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveScopes('', '', 'req-6')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

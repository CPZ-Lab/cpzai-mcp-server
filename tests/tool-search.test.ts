import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Request } from 'express';
import { createMcpServer } from '../src/server.js';

const HEADERS = { 'x-cpz-key': 'test-key', 'x-cpz-secret': 'test-secret', 'x-request-id': 'mcp-test' };

async function connect(mode: 'full' | 'compact') {
  const server = createMcpServer({ headers: HEADERS } as unknown as Request, mode);
  const client = new Client({ name: 'discovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

function structured(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

describe('progressive tool discovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let open: Array<{ server: { close(): Promise<void> }; client: Client }>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    open = [];
  });

  afterEach(async () => {
    for (const { server, client } of open) {
      await client.close();
      await server.close();
    }
    vi.unstubAllGlobals();
  });

  async function compactClient() {
    const pair = await connect('compact');
    open.push(pair);
    return pair.client;
  }

  it('advertises every tool in full mode and no discovery tools', async () => {
    const pair = await connect('full');
    open.push(pair);
    const names = (await pair.client.listTools()).tools.map(tool => tool.name);
    expect(names).toHaveLength(31);
    expect(names).not.toContain('search_tools');
    expect(names).not.toContain('call_tool');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('advertises every state-changing tool plus read anchors in compact mode', async () => {
    const client = await compactClient();
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);

    // Anything that can move money or write credentials stays visible by name,
    // so the client gates approval on the tool the user actually sees.
    for (const write of [
      'place_order', 'execute_strategy', 'create_strategy', 'update_strategy',
      'create_connection', 'create_webhook', 'delete_webhook', 'sync_portfolio', 'compute_risk',
    ]) {
      expect(names).toContain(write);
    }
    expect(names).toContain('search_tools');
    expect(names).toContain('call_tool');
    for (const anchor of ['list_accounts', 'list_positions', 'list_orders', 'get_market_data']) {
      expect(names).toContain(anchor);
    }
    // Deferred: discoverable, not advertised.
    for (const deferred of ['list_cash_flows', 'get_bars', 'list_strategies', 'get_profile']) {
      expect(names).not.toContain(deferred);
    }
    // Compact carries well under half the bytes of the full catalogue.
    const full = createMcpServer({ headers: HEADERS } as unknown as Request, 'full');
    const fullClient = new Client({ name: 'budget', version: '1.0.0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await full.connect(s);
    await fullClient.connect(c);
    const fullBytes = JSON.stringify((await fullClient.listTools()).tools).length;
    await fullClient.close();
    await full.close();
    expect(JSON.stringify(tools).length).toBeLessThan(fullBytes * 0.5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('finds a deferred tool by a parameter name and returns its full input schema', async () => {
    const client = await compactClient();
    const result = await client.callTool({ name: 'search_tools', arguments: { query: 'unsettled cash flows' } });
    const data = structured(result);
    const names = data.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_cash_flows');
    const match = data.tools.find((tool: { name: string }) => tool.name === 'list_cash_flows');
    expect(match.read_only).toBe(true);
    expect(match.callable_via).toBe('call_tool');
    expect(match.category).toBe('middle-office');
    expect(Object.keys(match.input_schema.properties)).toContain('unsettled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists a category when given no query, and reports an empty match honestly', async () => {
    const client = await compactClient();
    const listed = structured(await client.callTool({ name: 'search_tools', arguments: { category: 'backtests', limit: 25 } }));
    expect(listed.tools.map((tool: { name: string }) => tool.name).sort())
      .toEqual(['get_backtest_result', 'get_backtest_results']);

    const empty = structured(await client.callTool({ name: 'search_tools', arguments: { query: 'zzzznotatool' } }));
    expect(empty.count).toBe(0);
    expect(empty.tools).toEqual([]);
    expect(empty.note).toMatch(/No tool matched/);
    expect((await client.callTool({ name: 'search_tools', arguments: { query: 'zzzznotatool' } }) as { isError?: boolean }).isError)
      .toBeUndefined();
  });

  it('requires a query or a category', async () => {
    const client = await compactClient();
    const result = await client.callTool({ name: 'search_tools', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result).code).toBe('invalid_arguments');
  });

  it('dispatches a discovered read-only tool with the same result as a direct call', async () => {
    const client = await compactClient();
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'list_cash_flows', arguments: { unsettled: true, limit: 10 } },
    });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(structured(result)).toEqual({ data: [], count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/cash-flows');
    expect(url).toContain('unsettled=true');
    expect(url).toContain('limit=10');
  });

  it('refuses to dispatch a state-changing tool, and never reaches the API', async () => {
    const client = await compactClient();
    const result = await client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'place_order',
        arguments: {
          account_id: 'acct-1', broker_credential_id: '123e4567-e89b-42d3-a456-426614174000',
          symbol: 'AAPL', side: 'buy', order_type: 'market', quantity: 1,
        },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result).code).toBe('not_dispatchable');
    expect(structured(result).error).toContain('call place_order directly');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an already-advertised read tool back to its own name', async () => {
    const client = await compactClient();
    const result = await client.callTool({ name: 'call_tool', arguments: { name: 'list_accounts' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result).code).toBe('call_directly');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names near matches for an unknown tool instead of guessing', async () => {
    const client = await compactClient();
    const result = await client.callTool({ name: 'call_tool', arguments: { name: 'list_bars' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result).code).toBe('unknown_tool');
    expect(structured(result).did_you_mean).toContain('get_bars');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates dispatched arguments against the real tool schema', async () => {
    const client = await compactClient();
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_data_file', arguments: { id: 'not-a-uuid' } },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const data = structured(result);
    expect(data.code).toBe('invalid_arguments');
    expect(data.issues[0].path).toBe('id');
    expect(data.input_schema.properties.id).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the tool\'s own argument transforms when dispatching', async () => {
    const client = await compactClient();
    await client.callTool({ name: 'call_tool', arguments: { name: 'get_bars', arguments: { symbols: ['soxx'] } } });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).symbols).toEqual(['SOXX']);
  });

  it('tells the model how to use the compact surface in the server instructions', async () => {
    const client = await compactClient();
    expect(client.getInstructions()).toContain('search_tools');
    expect(client.getInstructions()).toContain('call_tool dispatches read-only tools only');
  });
});

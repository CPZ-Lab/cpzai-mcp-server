import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Request } from 'express';
import { createMcpServer } from '../src/server.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('CPZAI MCP protocol', () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    server = createMcpServer({ headers: { 'x-cpz-key': 'test-key', 'x-cpz-secret': 'test-secret', 'x-request-id': 'mcp-test' } } as unknown as Request);
    client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
  });

  it('negotiates tools, resources, prompts and workflow instructions without an upstream request', async () => {
    expect(client.getServerVersion()?.version).toBe('1.3.0');
    expect(client.getInstructions()).toContain('unknown outcome');
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(31);
    expect(new Set(tools.map(tool => tool.name)).size).toBe(31);
    expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual([
      'cpzai://guides/tool-usage', 'cpzai://guides/permissions', 'cpzai://guides/discovery',
    ]);
    expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['review_portfolio', 'analyze_strategy']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns readable resources and read-only prompts', async () => {
    const resource = await client.readResource({ uri: 'cpzai://guides/tool-usage' });
    expect(resource.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: expect.stringContaining('current page size') });
    const prompt = await client.getPrompt({ name: 'analyze_strategy', arguments: { strategy_id: ID } });
    expect(prompt.messages[0].content).toMatchObject({ type: 'text', text: expect.stringContaining('do not update or execute') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['list_positions', 'list_accounts', 'list_connections', 'list_risk_snapshots', 'list_webhooks'])(
    '%s forwards paging and keeps structured and text results equivalent', async name => {
      const result = await client.callTool({ name, arguments: { limit: 10, offset: 20 } });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(new URL(url).searchParams.get('limit')).toBe('10');
      expect(new URL(url).searchParams.get('offset')).toBe('20');
      expect(new Headers(init.headers).get('x-request-id')).toBe('mcp-test');
      expect(result.structuredContent).toEqual({ data: [], count: 0 });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(result.structuredContent);
    },
  );

  it('preserves false account and webhook filters', async () => {
    await client.callTool({ name: 'list_accounts', arguments: { tradable: false, environment: 'paper' } });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('tradable')).toBe('false');
    await client.callTool({ name: 'list_webhooks', arguments: { active: false } });
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('active')).toBe('false');
  });

  it.each([
    ['list_positions', { limit: 0 }],
    ['list_connections', { offset: -1 }],
    ['list_accounts', { limit: 1.5 }],
    ['list_strategies', { limit: 101 }],
    ['get_strategy', { id: '../orders' }],
    ['get_market_data', { symbols: [] }],
    ['get_market_data', { symbols: ['AAPL,MSFT'] }],
    ['get_bars', { symbols: ['AAPL'], start: '2026-02-30' }],
    ['get_bars', { symbols: ['AAPL'], start: '2026-01-02', end: '2026-01-01' }],
    ['get_bars', { symbols: ['AAPL'], limit: 10001 }],
    ['create_webhook', { url: 'http://example.com', events: ['order.filled'] }],
    ['create_webhook', { url: 'https://example.com', events: [] }],
    ['update_strategy', { id: ID }],
  ])('rejects invalid %s arguments before any API request', async (name, args) => {
    const result = await client.callTool({ name: name as string, arguments: args as Record<string, unknown> });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const order = { account_id: 'paper-account', broker_credential_id: ID, symbol: 'aapl', side: 'buy', quantity: 1 };

  it.each([
    { order_type: 'limit' },
    { order_type: 'stop' },
    { order_type: 'stop_limit', price: 105 },
    { order_type: 'stop_limit', stop_price: 100 },
    { order_type: 'market', quantity: -1 },
    { order_type: 'limit', price: 0 },
    { order_type: 'market', time_in_force: 'gtc' },
  ])('rejects invalid order terms %j', async terms => {
    const result = await client.callTool({ name: 'place_order', arguments: { ...order, ...terms } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards both stop-limit prices and a normalized symbol', async () => {
    const result = await client.callTool({ name: 'place_order', arguments: { ...order, order_type: 'stop_limit', price: 105, stop_price: 100, time_in_force: 'day' } });
    expect(result.isError).not.toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ symbol: 'AAPL', price: 105, stop_price: 100, time_in_force: 'day' });
  });

  it('surfaces an uncertain order timeout without resubmitting', async () => {
    fetchMock.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    const result = await client.callTool({ name: 'place_order', arguments: { ...order, order_type: 'market' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ operation_outcome: 'unknown', request_id: 'mcp-test' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

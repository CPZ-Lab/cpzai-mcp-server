import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

const id = '5a5d40e6-53f9-4be6-9ebc-d0f83a7f1b71';
const entityId = '96043206-24a4-4d63-9cd7-04c51ccf7d7c';

describe('expanded tools over MCP', () => {
  let client: Client;
  let server: McpServer;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // The REST client captures its base URL when imported. Keep this suite's
    // mount-path contract independent of the host/CI environment.
    vi.stubEnv('CPZ_API_BASE_URL', 'https://api.example.test/functions/v1/rest-api');
    vi.stubEnv('CPZ_API_TIMEOUT_MS', '20000');
    vi.resetModules();
    const { registerExpandedTools } = await import('../src/expanded-tools.js');
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    server = new McpServer({ name: 'expanded-test', version: '1.0.0' });
    registerExpandedTools(server, { apiKey: 'test-key', apiSecret: 'test-secret', requestId: 'test-request' });
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
  });

  it('advertises all ten additions as read-only, idempotent tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_backtest_result', 'get_data_file', 'get_order', 'get_risk_snapshot',
      'list_cash_flows', 'list_data_files', 'list_deals', 'list_fund_periods',
      'list_journal_entries', 'list_lifecycle_events',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it.each([
    ['get_data_file', '/data-files'],
    ['get_backtest_result', '/backtests'],
    ['get_order', '/orders'],
    ['get_risk_snapshot', '/risk-snapshots'],
  ])('%s retrieves the exact record through the existing endpoint', async (name, path) => {
    const payload = { data: { id, result: { verified: false }, nullable_field: null } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    const result = await client.callTool({ name, arguments: { id } });
    expect(result.isError).not.toBe(true);
    const [rawUrl, init] = fetchMock.mock.calls[0];
    expect(new URL(rawUrl).origin).toBe('https://api.example.test');
    expect(new URL(rawUrl).pathname).toBe(`/functions/v1/rest-api/v1${path}/${id}`);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'X-CPZ-Key': 'test-key', 'X-CPZ-Secret': 'test-secret' });
    expect(init.body).toBeUndefined();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(payload);
  });

  it.each([
    ['list_data_files', '/data-files', { status: 'ready', file_type: 'csv', name: 'Earnings', sort_by: 'name' }],
    ['list_deals', '/deals', { entity_id: entityId, deal_id: 'IRS-1', fund: 'Alpha', book: 'Rates', product_kind: 'IRS', status: 'LIVE', sort_by: 'trade_date' }],
    ['list_lifecycle_events', '/lifecycle-events', { entity_id: entityId, deal_id: 'IRS-1', kind: 'FIXING', status: 'PENDING', from: '2026-01-01', to: '2026-12-31', sort_by: 'event_date' }],
    ['list_cash_flows', '/cash-flows', { entity_id: entityId, deal_id: 'IRS-1', fund: 'Alpha', book: 'Rates', unsettled: false, from: '2024-02-29', to: '2026-12-31', sort_by: 'payment_date' }],
    ['list_journal_entries', '/journal-entries', { entity_id: entityId, deal_id: 'IRS-1', from: '2026-01-01', to: '2026-01-01', sort_by: 'entry_date' }],
    ['list_fund_periods', '/fund-periods', { entity_id: entityId, fund: 'Alpha', status: 'CLOSED', sort_by: 'period_end' }],
  ])('%s forwards supported filters and preserves zero/false values', async (name, path, filters) => {
    const args = { ...filters, limit: 100, offset: 0, sort_order: 'asc' };
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.origin).toBe('https://api.example.test');
    expect(url.pathname).toBe(`/functions/v1/rest-api/v1${path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])));
    expect(init.method).toBe('GET');
  });

  it.each(['get_data_file', 'get_backtest_result', 'get_order', 'get_risk_snapshot'])('%s rejects malformed or path-like identifiers before HTTP', async (name) => {
    const result = await client.callTool({ name, arguments: { id: '../accounts' } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 },
    { entity_id: 'not-an-entity-uuid' }, { sort_by: 'missing_column' },
  ])('rejects invalid list bounds or entity filters: %j', async (args) => {
    const result = await client.callTool({ name: 'list_deals', arguments: args });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '09/14/2026', '2026-09-14T10:00:00Z'])('rejects invalid calendar dates: %s', async (from) => {
    const result = await client.callTool({ name: 'list_lifecycle_events', arguments: { from } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['list_lifecycle_events', 'list_cash_flows', 'list_journal_entries'])('%s refuses reversed date ranges before HTTP', async (name) => {
    const result = await client.callTool({ name, arguments: { from: '2026-09-14', to: '2026-09-13' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('from must be on or before to');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves exact minor-unit strings without numerical coercion', async () => {
    const payload = { data: [{ amount_minor: '9007199254740993123', economic_amount: null }] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    const result = await client.callTool({ name: 'list_cash_flows', arguments: { unsettled: true } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(payload);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('unsettled')).toBe('true');
  });

  it.each([403, 404, 429, 500])('surfaces upstream HTTP %i as an MCP error', async (status) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Upstream refused the read' }), { status }));
    const result = await client.callTool({ name: 'get_order', arguments: { id } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Upstream refused the read');
  });
});

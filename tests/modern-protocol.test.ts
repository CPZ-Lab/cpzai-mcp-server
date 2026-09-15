import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Request as ExpressRequest } from 'express';
import { createMcpServer, type ServerOptions } from '../src/server.js';

const HEADERS = { 'x-cpz-key': 'test-key', 'x-cpz-secret': 'test-secret' };
const MODERN = '2026-07-28';

function meta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/**
 * One stateless 2026-07-28 request: no initialize, `Mcp-Method` routing so a
 * gateway can dispatch without parsing the body, identity in `_meta`.
 */
async function send(method: string, params: Record<string, unknown> = {}, options: ServerOptions = {}, name?: string) {
  const handler = createMcpHandler(() => createMcpServer({ headers: HEADERS } as unknown as ExpressRequest, options), {
    legacy: 'stateless',
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-method': method,
  };
  if (name) headers['mcp-name'] = name;
  const response = await handler.fetch(new Request('https://mcp.test/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta() } }),
  }));
  const text = await response.text();
  const payload = text.startsWith('data: ') || text.includes('\ndata: ')
    ? JSON.parse(text.split('data: ').pop() as string)
    : JSON.parse(text);
  await handler.close?.();
  return { status: response.status, ...payload };
}

describe('the 2026-07-28 revision', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('answers tools/list with no handshake at all', async () => {
    const { result, error } = await send('tools/list');
    expect(error).toBeUndefined();
    expect(result.resultType).toBe('complete');
    expect(result.tools).toHaveLength(31);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks list results cacheable, and never with a shared cache', async () => {
    const { result } = await send('tools/list');
    expect(result.ttlMs).toBe(60_000);
    // tools/list is filtered per credential, so a public cache would hand one
    // key's catalogue to another.
    expect(result.cacheScope).toBe('private');
  });

  it('serves server/discover, which the legacy era has no equivalent for', async () => {
    const { result, error } = await send('server/discover');
    expect(error).toBeUndefined();
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect(result.instructions).toContain('CPZAI provides user-scoped trading');
  });

  it('describes the compact surface in its own discover response', async () => {
    const { result } = await send('server/discover', {}, { mode: 'compact' });
    expect(result.instructions).toContain('call_tool dispatches read-only tools only');
    const list = await send('tools/list', {}, { mode: 'compact' });
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('search_tools');
    expect(list.result.tools).toHaveLength(15);
  });

  it('applies scope filtering on the modern path too', async () => {
    const { result } = await send('tools/list', {}, { scopes: new Set(['data']) });
    const names = result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toHaveLength(10);
    expect(names).not.toContain('place_order');
  });

  it('routes a tool call by header and returns the same result shape', async () => {
    const { result, error } = await send(
      'tools/call',
      { name: 'search_tools', arguments: { query: 'unsettled cash flows' } },
      { mode: 'compact' },
      'search_tools',
    );
    expect(error).toBeUndefined();
    expect(result.resultType).toBe('complete');
    expect(result.structuredContent.tools.map((tool: { name: string }) => tool.name)).toContain('list_cash_flows');
  });

  it('rejects a body whose method the routing header does not name', async () => {
    const handler = createMcpHandler(() => createMcpServer({ headers: HEADERS } as unknown as ExpressRequest), {
      legacy: 'stateless',
    });
    const response = await handler.fetch(new Request('https://mcp.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }),
    }));
    const body = await response.json() as { error?: { message: string } };
    expect(body.error?.message).toMatch(/Mcp-Method header is absent/);
    await handler.close?.();
  });
});

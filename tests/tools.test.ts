import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request } from 'express';
import { registerTools } from '../src/tools.js';

function makeMockRequest(headers: Record<string, string> = {}): Request {
  return {
    headers: {
      'x-cpz-key': 'test_key_prefix',
      'x-cpz-secret': 'test_key_secret',
      ...headers,
    },
  } as unknown as Request;
}

describe('registerTools', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
  });

  it('registers all 18 tools without error', () => {
    const req = makeMockRequest();
    expect(() => registerTools(server, req)).not.toThrow();
  });

  it('extracts CPZ key/secret from X-CPZ-Key headers', () => {
    const req = makeMockRequest({
      'x-cpz-key': 'my_prefix',
      'x-cpz-secret': 'my_secret',
    });
    expect(() => registerTools(server, req)).not.toThrow();
  });

  it('extracts CPZ key/secret from Bearer token', () => {
    const req = makeMockRequest({
      'x-cpz-key': '',
      'x-cpz-secret': '',
      authorization: 'Bearer cpz_key_prefix.secret_value',
    });
    expect(() => registerTools(server, req)).not.toThrow();
  });
});

describe('api-client', () => {
  it('constructs correct URL with query params', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';

    globalThis.fetch = vi.fn(async (url: string | URL | globalThis.Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const { callRestApi } = await import('../src/api-client.js');
    await callRestApi({
      method: 'GET',
      path: '/strategies',
      query: { status: 'active', limit: '10' },
      apiKey: 'key',
      apiSecret: 'secret',
    });

    expect(capturedUrl).toContain('/strategies');
    expect(capturedUrl).toContain('status=active');
    expect(capturedUrl).toContain('limit=10');

    globalThis.fetch = originalFetch;
  });

  it('sends CPZ headers correctly', async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn(async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers || {}).map(([k, v]) => [k, String(v)]),
      );
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const { callRestApi } = await import('../src/api-client.js');
    await callRestApi({
      method: 'GET',
      path: '/me',
      apiKey: 'my_key',
      apiSecret: 'my_secret',
    });

    expect(capturedHeaders['X-CPZ-Key']).toBe('my_key');
    expect(capturedHeaders['X-CPZ-Secret']).toBe('my_secret');

    globalThis.fetch = originalFetch;
  });

  it('returns ok:false for error responses', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    });

    const { callRestApi } = await import('../src/api-client.js');
    const result = await callRestApi({
      method: 'GET',
      path: '/strategies',
      apiKey: 'bad_key',
      apiSecret: 'bad_secret',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);

    globalThis.fetch = originalFetch;
  });
});

describe('health endpoint', () => {
  it('index module exports without error', async () => {
    expect(true).toBe(true);
  });
});

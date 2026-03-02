import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request } from 'express';
import { callRestApi } from './api-client.js';

/**
 * Extract CPZ API credentials from the incoming HTTP request.
 * Agents pass their API key/secret in headers, which we forward to the REST API.
 */
function extractCredentials(req: Request): { apiKey: string; apiSecret: string } {
  const cpzKey = req.headers['x-cpz-key'] as string | undefined;
  const cpzSecret = req.headers['x-cpz-secret'] as string | undefined;

  if (cpzKey && cpzSecret) {
    return { apiKey: cpzKey, apiSecret: cpzSecret };
  }

  const auth = req.headers['authorization'] as string | undefined;
  if (auth?.startsWith('Bearer ') && auth.includes('cpz_key_')) {
    const token = auth.slice(7);
    const dotIndex = token.indexOf('.');
    if (dotIndex > 0) {
      return { apiKey: token.slice(0, dotIndex), apiSecret: token.slice(dotIndex + 1) };
    }
  }

  return { apiKey: '', apiSecret: '' };
}

function formatResult(result: { ok: boolean; status: number; data: unknown }) {
  const text = JSON.stringify(result.data, null, 2);
  if (!result.ok) {
    return { content: [{ type: 'text' as const, text: `Error (${result.status}): ${text}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text }] };
}

export function registerTools(server: McpServer, req: Request) {
  const creds = extractCredentials(req);

  // ── Strategies ──────────────────────────────────────────────

  server.registerTool('list_strategies', {
    title: 'List Strategies',
    description: 'List all trading strategies. Supports filtering by status, type, and title search.',
    inputSchema: z.object({
      status: z.string().optional().describe('Filter by status (e.g. active, draft)'),
      strategy_type: z.string().optional().describe('Filter by strategy type'),
      title: z.string().optional().describe('Search in titles (partial match)'),
      limit: z.number().optional().describe('Max results (1-100)'),
      offset: z.number().optional().describe('Skip N results'),
    }),
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.status) query.status = args.status;
    if (args.strategy_type) query.strategy_type = args.strategy_type;
    if (args.title) query.title = args.title;
    if (args.limit) query.limit = String(args.limit);
    if (args.offset) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/strategies', query, ...creds });
    return formatResult(result);
  });

  server.registerTool('get_strategy', {
    title: 'Get Strategy',
    description: 'Get a specific strategy by ID.',
    inputSchema: z.object({ id: z.string().describe('Strategy UUID') }),
  }, async (args) => {
    const result = await callRestApi({ method: 'GET', path: `/strategies/${args.id}`, ...creds });
    return formatResult(result);
  });

  server.registerTool('create_strategy', {
    title: 'Create Strategy',
    description: 'Create a new trading strategy.',
    inputSchema: z.object({
      title: z.string().describe('Strategy title'),
      description: z.string().optional(),
      strategy_type: z.string().optional().describe('e.g. momentum, mean_reversion'),
      python_code: z.string().optional().describe('Python code for the strategy'),
      status: z.string().optional().describe('e.g. draft, active'),
    }),
  }, async (args) => {
    const result = await callRestApi({ method: 'POST', path: '/strategies', body: args, ...creds });
    return formatResult(result);
  });

  server.registerTool('update_strategy', {
    title: 'Update Strategy',
    description: 'Update an existing strategy. Pass only the fields to change.',
    inputSchema: z.object({
      id: z.string().describe('Strategy UUID'),
      title: z.string().optional(),
      description: z.string().optional(),
      python_code: z.string().optional(),
      status: z.string().optional(),
    }),
  }, async (args) => {
    const { id, ...body } = args;
    const result = await callRestApi({ method: 'PATCH', path: `/strategies/${id}`, body, ...creds });
    return formatResult(result);
  });

  // ── Backtests ───────────────────────────────────────────────

  server.registerTool('get_backtest_results', {
    title: 'Get Backtest Results',
    description: 'List backtest run results, optionally filtered by strategy.',
    inputSchema: z.object({
      strategy_id: z.string().optional().describe('Filter by strategy UUID'),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.strategy_id) query.strategy_id = args.strategy_id;
    if (args.limit) query.limit = String(args.limit);
    if (args.offset) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/backtests', query, ...creds });
    return formatResult(result);
  });

  // ── Orders ──────────────────────────────────────────────────

  server.registerTool('list_orders', {
    title: 'List Orders',
    description: 'List trading orders. Filter by status, symbol, side, or strategy.',
    inputSchema: z.object({
      status: z.string().optional(),
      symbol: z.string().optional(),
      side: z.string().optional().describe('buy or sell'),
      strategy_id: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.status) query.status = args.status;
    if (args.symbol) query.symbol = args.symbol;
    if (args.side) query.side = args.side;
    if (args.strategy_id) query.strategy_id = args.strategy_id;
    if (args.limit) query.limit = String(args.limit);
    if (args.offset) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/orders', query, ...creds });
    return formatResult(result);
  });

  server.registerTool('place_order', {
    title: 'Place Order',
    description: 'Place a new trading order through a connected broker.',
    inputSchema: z.object({
      account_id: z.string().describe('Trading account ID'),
      broker_credential_id: z.string().describe('Broker credential ID'),
      symbol: z.string().describe('Ticker symbol (e.g. AAPL)'),
      side: z.enum(['buy', 'sell']),
      order_type: z.enum(['market', 'limit', 'stop', 'stop_limit']),
      quantity: z.number().describe('Number of shares'),
      price: z.number().optional().describe('Limit price (required for limit orders)'),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (args) => {
    const result = await callRestApi({ method: 'POST', path: '/orders', body: args, ...creds });
    return formatResult(result);
  });

  // ── Positions ───────────────────────────────────────────────

  server.registerTool('list_positions', {
    title: 'List Positions',
    description: 'List current portfolio positions.',
    inputSchema: z.object({
      account_id: z.string().optional(),
      symbol: z.string().optional(),
    }),
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.account_id) query.account_id = args.account_id;
    if (args.symbol) query.symbol = args.symbol;
    const result = await callRestApi({ method: 'GET', path: '/positions', query, ...creds });
    return formatResult(result);
  });

  // ── Portfolio ───────────────────────────────────────────────

  server.registerTool('sync_portfolio', {
    title: 'Sync Portfolio',
    description: 'Trigger a portfolio sync across all connected broker accounts.',
    inputSchema: z.object({}),
  }, async () => {
    const result = await callRestApi({ method: 'POST', path: '/portfolio-sync', ...creds });
    return formatResult(result);
  });

  // ── Accounts ────────────────────────────────────────────────

  server.registerTool('list_accounts', {
    title: 'List Accounts',
    description: 'List connected trading accounts (broker credentials). Sensitive fields excluded.',
    inputSchema: z.object({
      broker: z.string().optional().describe('Filter by broker (alpaca, ibkr)'),
      environment: z.string().optional().describe('live or paper'),
    }),
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.broker) query.broker = args.broker;
    if (args.environment) query.environment = args.environment;
    const result = await callRestApi({ method: 'GET', path: '/accounts', query, ...creds });
    return formatResult(result);
  });

  // ── Market Data ─────────────────────────────────────────────

  server.registerTool('get_market_data', {
    title: 'Get Market Data',
    description: 'Fetch real-time market data (price, bid/ask, volume) for one or more symbols.',
    inputSchema: z.object({
      symbols: z.array(z.string()).describe('Ticker symbols (e.g. ["AAPL", "MSFT"])'),
    }),
  }, async (args) => {
    const result = await callRestApi({
      method: 'POST',
      path: '/market-data',
      query: { symbols: args.symbols.join(',') },
      ...creds,
    });
    return formatResult(result);
  });

  // ── Risk ────────────────────────────────────────────────────

  server.registerTool('compute_risk', {
    title: 'Compute Risk',
    description: 'Compute a fresh risk snapshot for the portfolio. Returns VaR, Sharpe, drawdown, exposures, and risk score.',
    inputSchema: z.object({
      account_id: z.string().optional().describe('Compute for a specific account'),
    }),
  }, async (args) => {
    const body: Record<string, unknown> = {};
    if (args.account_id) body.account_id = args.account_id;
    const result = await callRestApi({ method: 'POST', path: '/risk-compute', body, ...creds });
    return formatResult(result);
  });

  server.registerTool('list_risk_snapshots', {
    title: 'List Risk Snapshots',
    description: 'List historical risk snapshots.',
    inputSchema: z.object({
      account_id: z.string().optional(),
      limit: z.number().optional(),
    }),
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.account_id) query.account_id = args.account_id;
    if (args.limit) query.limit = String(args.limit);
    const result = await callRestApi({ method: 'GET', path: '/risk-snapshots', query, ...creds });
    return formatResult(result);
  });

  // ── Execute Strategy ────────────────────────────────────────

  server.registerTool('execute_strategy', {
    title: 'Execute Strategy',
    description: 'Execute a strategy on the Python backend. Returns execution results.',
    inputSchema: z.object({
      strategy_id: z.string().describe('Strategy UUID to execute'),
      code: z.string().optional().describe('Optional Python code override'),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (args) => {
    const result = await callRestApi({ method: 'POST', path: '/execute', body: args, ...creds });
    return formatResult(result);
  });

  // ── Webhooks ────────────────────────────────────────────────

  server.registerTool('list_webhooks', {
    title: 'List Webhooks',
    description: 'List configured webhook subscriptions.',
    inputSchema: z.object({}),
  }, async () => {
    const result = await callRestApi({ method: 'GET', path: '/webhooks', ...creds });
    return formatResult(result);
  });

  server.registerTool('create_webhook', {
    title: 'Create Webhook',
    description: 'Subscribe to platform events via webhook. Returns the signing secret (save it — shown once).',
    inputSchema: z.object({
      url: z.string().url().describe('HTTPS endpoint to receive events'),
      events: z.array(z.enum([
        'order.placed', 'order.filled',
        'strategy.executed',
        'backtest.completed',
        'risk.alert',
        'news.breaking',
      ])).describe('Events to subscribe to'),
      description: z.string().optional(),
    }),
  }, async (args) => {
    const result = await callRestApi({ method: 'POST', path: '/webhooks', body: args, ...creds });
    return formatResult(result);
  });

  server.registerTool('delete_webhook', {
    title: 'Delete Webhook',
    description: 'Remove a webhook subscription.',
    inputSchema: z.object({ id: z.string().describe('Webhook UUID') }),
    annotations: { destructiveHint: true },
  }, async (args) => {
    const result = await callRestApi({ method: 'DELETE', path: `/webhooks/${args.id}`, ...creds });
    return formatResult(result);
  });

  // ── User Profile ────────────────────────────────────────────

  server.registerTool('get_profile', {
    title: 'Get Profile',
    description: 'Get the current authenticated user profile.',
    inputSchema: z.object({}),
  }, async () => {
    const result = await callRestApi({ method: 'GET', path: '/me', ...creds });
    return formatResult(result);
  });
}

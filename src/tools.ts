import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request } from 'express';
import { callRestApi } from './api-client.js';
import { resolveAccessToken } from './oauth.js';
import { formatResult, invalidArguments } from './tool-result.js';
import { registerExpandedTools } from './expanded-tools.js';

const pageLimit = z.number().int().min(1).max(100).optional().describe('Page size (default 50, maximum 100)');
const pageOffset = z.number().int().min(0).optional().describe('Rows to skip; increase by returned count for the next page');
const identifier = z.string().uuid();
const symbol = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9^][A-Za-z0-9./:_=^\-]*$/).transform(value => value.toUpperCase());
const symbols = z.array(symbol).min(1).max(100);
const dateTime = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === day
    && (value.length === 10 || z.string().datetime({ offset: true }).safeParse(value).success);
}, 'Use a valid ISO 8601 date or timestamp with timezone');

/**
 * Extract CPZ API credentials from the incoming HTTP request.
 * Agents pass their API key/secret in headers, which we forward to the REST API.
 */
export function extractCredentials(req: Request): { apiKey: string; apiSecret: string } {
  const cpzKey = req.headers['x-cpz-key'] as string | undefined;
  const cpzSecret = req.headers['x-cpz-secret'] as string | undefined;

  if (cpzKey && cpzSecret) {
    return { apiKey: cpzKey, apiSecret: cpzSecret };
  }

  const auth = req.headers['authorization'] as string | undefined;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    // Preferred: opaque OAuth access token resolved to credentials server-side.
    const resolved = resolveAccessToken(token);
    if (resolved) return resolved;
    // Backward-compat: direct `cpz_key_*.secret` bearer is gated behind env flag
    // to avoid accidental secret exposure in logs/proxies. Set ALLOW_LEGACY_BEARER=true to enable.
    if (process.env.ALLOW_LEGACY_BEARER === 'true' && token.startsWith('cpz_key_')) {
      const dotIndex = token.indexOf('.');
      if (dotIndex > 0) {
        console.warn('[tools] Legacy bearer cpz_key_.* used — migrate to X-CPZ-Key/Secret or OAuth');
        return { apiKey: token.slice(0, dotIndex), apiSecret: token.slice(dotIndex + 1) };
      }
    } else if (token.includes('cpz_key_')) {
      console.warn('[tools] Rejected legacy cpz_key_ bearer — enable ALLOW_LEGACY_BEARER=true if needed');
    }
  }

  return { apiKey: '', apiSecret: '' };
}

export function registerTools(server: McpServer, req: Request) {
  const requestId = req.headers['x-request-id'];
  const creds = { ...extractCredentials(req), requestId: typeof requestId === 'string' ? requestId : undefined };
  registerExpandedTools(server, creds);

  // ── Strategies ──────────────────────────────────────────────

  server.registerTool('list_strategies', {
    title: 'List Strategies',
    description: 'List all trading strategies. Supports filtering by status, type, and title search.',
    inputSchema: z.object({
      status: z.string().optional().describe('Filter by status (e.g. active, draft)'),
      strategy_type: z.string().optional().describe('Filter by strategy type'),
      title: z.string().optional().describe('Search in titles (partial match)'),
      limit: pageLimit,
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    inputSchema: z.object({ id: identifier.describe('Strategy UUID') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const result = await callRestApi({ method: 'GET', path: `/strategies/${args.id}`, ...creds });
    return formatResult(result);
  });

  server.registerTool('create_strategy', {
    title: 'Create Strategy',
    description: 'Create a new trading strategy.',
    inputSchema: z.object({
      title: z.string().trim().min(1).max(200).describe('Strategy title'),
      description: z.string().optional(),
      strategy_type: z.string().optional().describe('e.g. momentum, mean_reversion'),
      python_code: z.string().optional().describe('Python code for the strategy'),
      status: z.string().optional().describe('e.g. draft, active'),
    }),
    annotations: { readOnlyHint: false },
  }, async (args) => {
    const result = await callRestApi({ method: 'POST', path: '/strategies', body: args, ...creds });
    return formatResult(result);
  });

  server.registerTool('update_strategy', {
    title: 'Update Strategy',
    description: 'Update an existing strategy. Pass only the fields to change.',
    inputSchema: z.object({
      id: identifier.describe('Strategy UUID'),
      title: z.string().optional(),
      description: z.string().optional(),
      strategy_type: z.string().trim().min(1).optional(),
      python_code: z.string().optional(),
      status: z.string().optional(),
    }),
    annotations: { readOnlyHint: false },
  }, async (args) => {
    const { id, ...body } = args;
    if (Object.keys(body).length === 0) return invalidArguments('Provide at least one strategy field to update');
    const result = await callRestApi({ method: 'PATCH', path: `/strategies/${id}`, body, ...creds });
    return formatResult(result);
  });

  // ── Backtests ───────────────────────────────────────────────

  server.registerTool('get_backtest_results', {
    title: 'Get Backtest Results',
    description: 'List backtest run results, optionally filtered by strategy.',
    inputSchema: z.object({
      strategy_id: identifier.optional().describe('Filter by strategy UUID'),
      limit: pageLimit,
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      symbol: symbol.optional(),
      side: z.string().optional().describe('buy or sell'),
      strategy_id: identifier.optional(),
      limit: pageLimit,
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    description: 'Place an order using a tradable account from list_accounts. Check its broker and environment; live accounts can trade real money. Stop orders and time-in-force support depend on the broker. After a timeout, inspect list_orders before retrying; submission may have succeeded.',
    inputSchema: z.object({
      account_id: z.string().trim().min(1).describe('Trading account ID from list_accounts'),
      broker_credential_id: identifier.describe('Tradable broker credential ID from list_accounts'),
      symbol: symbol.describe('Ticker symbol (e.g. AAPL)'),
      side: z.enum(['buy', 'sell']),
      order_type: z.enum(['market', 'limit', 'stop', 'stop_limit']),
      quantity: z.number().finite().positive().describe('Positive quantity; fractional shares depend on the broker'),
      price: z.number().finite().positive().optional().describe('Limit price; required for limit and stop_limit orders'),
      stop_price: z.number().finite().positive().optional().describe('Trigger price; required for stop and stop_limit orders. Broker support varies.'),
      time_in_force: z.literal('day').optional().describe('Day orders only; other durations are not consistently supported by all routes'),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (args) => {
    if (['limit', 'stop_limit'].includes(args.order_type) && args.price === undefined) {
      return invalidArguments('price is required for limit and stop_limit orders');
    }
    if (['stop', 'stop_limit'].includes(args.order_type) && args.stop_price === undefined) {
      return invalidArguments('stop_price is required for stop and stop_limit orders');
    }
    const result = await callRestApi({ method: 'POST', path: '/orders', body: args, ...creds });
    return formatResult(result);
  });

  // ── Positions ───────────────────────────────────────────────

  server.registerTool('list_positions', {
    title: 'List Positions',
    description: 'List one page of portfolio positions. Continue with offset until a short page is returned before concluding a portfolio review.',
    inputSchema: z.object({
      account_id: z.string().optional(),
      symbol: symbol.optional(),
      limit: pageLimit,
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.account_id) query.account_id = args.account_id;
    if (args.symbol) query.symbol = args.symbol;
    if (args.limit !== undefined) query.limit = String(args.limit);
    if (args.offset !== undefined) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/positions', query, ...creds });
    return formatResult(result);
  });

  // ── Portfolio ───────────────────────────────────────────────

  server.registerTool('sync_portfolio', {
    title: 'Sync Portfolio',
    description: 'Trigger a portfolio sync across all connected broker accounts.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false },
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
      environment: z.enum(['live', 'paper']).optional().describe('live or paper'),
      tradable: z.boolean().optional().describe('true includes only tradable accounts; false or omitted includes all accounts'),
      limit: pageLimit.describe('Page size (default 100, maximum 100)'),
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.broker) query.broker = args.broker;
    if (args.environment) query.environment = args.environment;
    if (args.tradable !== undefined) query.tradable = String(args.tradable);
    if (args.limit !== undefined) query.limit = String(args.limit);
    if (args.offset !== undefined) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/accounts', query, ...creds });
    return formatResult(result);
  });

  // ── Data connections ────────────────────────────────────────
  //
  // These exist so an OAuth client can manage connections at all. The browser
  // writes them through the `api-connections` edge function, which
  // authenticates a Supabase user JWT; a CLI or agent holds an API key or one
  // of our sealed bearer tokens and never a JWT, so without these tools its
  // only path to /connections was a direct call that rest-api correctly
  // refuses. Routing through here means the token is unsealed once, server
  // side, and the credential itself is encrypted by the same helper the
  // browser path uses.

  server.registerTool('list_connections', {
    title: 'List Data Connections',
    description: 'List the user\'s configured data-provider connections. Credentials are never returned.',
    inputSchema: z.object({
      connection_type: z.string().optional().describe('Filter by provider, e.g. polygon, databento'),
      limit: pageLimit,
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.connection_type) query.connection_type = args.connection_type;
    if (args.limit !== undefined) query.limit = String(args.limit);
    if (args.offset !== undefined) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/connections', query, ...creds });
    return formatResult(result);
  });

  server.registerTool('create_connection', {
    title: 'Create Data Connection',
    description:
      'Store a data-provider API key. The credential is encrypted server-side and can never be read back. One connection per provider.',
    inputSchema: z.object({
      connection_type: z.string().describe('Provider id, e.g. polygon, databento, finnhub'),
      connection_name: z.string().describe('Display name for the connection'),
      api_key: z.string().optional().describe('The provider API key'),
      secret_token: z.string().optional().describe('Secondary secret, for providers that need a pair'),
      configuration: z.record(z.unknown()).optional().describe('Non-secret provider settings'),
    }),
    // Writes a credential, so it is explicitly not read-only and not
    // idempotent: a second call for the same provider is a 409, not a no-op.
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (args) => {
    const result = await callRestApi({
      method: 'POST',
      path: '/connections',
      body: {
        connection_type: args.connection_type,
        connection_name: args.connection_name,
        api_key: args.api_key,
        secret_token: args.secret_token,
        configuration: args.configuration ?? {},
      },
      ...creds,
    });
    return formatResult(result);
  });

  // ── Market Data ─────────────────────────────────────────────

  server.registerTool('get_market_data', {
    title: 'Get Market Data',
    description: 'Fetch real-time market data (price, bid/ask, volume) for one or more symbols.',
    inputSchema: z.object({
      symbols: symbols.describe('Ticker symbols (e.g. ["AAPL", "MSFT"])'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const result = await callRestApi({
      method: 'POST',
      path: '/market-data',
      query: { symbols: args.symbols.join(',') },
      ...creds,
    });
    return formatResult(result);
  });

  server.registerTool('get_bars', {
    title: 'Get Historical Bars',
    description: 'Fetch historical OHLCV bars for one or more symbols. Supports intraday (1Min–4Hour) and daily/weekly/monthly timeframes over a date range — the historical data the real-time quote tool cannot provide.',
    inputSchema: z.object({
      symbols: symbols.describe('Ticker symbols (e.g. ["SOXX", "SOXL"])'),
      timeframe: z.enum(['1Min', '5Min', '15Min', '30Min', '1Hour', '2Hour', '4Hour', '1Day', '1Week', '1Month'])
        .optional().describe('Bar size (default 1Day)'),
      feed: z.enum(['iex', 'sip']).optional().describe('Alpaca data feed; SIP requires the appropriate entitlement'),
      start: dateTime.optional().describe('Start date/time, ISO 8601 (e.g. 2024-01-01)'),
      end: dateTime.optional().describe('End date/time, ISO 8601 (e.g. 2026-06-30)'),
      limit: z.number().int().min(1).max(10000).optional().describe('Max bars per symbol (default 1000, max 10000)'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    if (args.start && args.end && Date.parse(args.start) > Date.parse(args.end)) {
      return invalidArguments('start must be on or before end');
    }
    const result = await callRestApi({
      method: 'POST',
      path: '/bars',
      body: {
        symbols: args.symbols,
        timeframe: args.timeframe,
        feed: args.feed,
        start: args.start,
        end: args.end,
        limit: args.limit,
      },
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
    annotations: { readOnlyHint: false },
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
      limit: pageLimit,
      offset: pageOffset,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.account_id) query.account_id = args.account_id;
    if (args.limit) query.limit = String(args.limit);
    if (args.offset !== undefined) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/risk-snapshots', query, ...creds });
    return formatResult(result);
  });

  // ── Execute Strategy ────────────────────────────────────────

  server.registerTool('execute_strategy', {
    title: 'Execute Strategy',
    description: 'Execute a strategy on the Python backend. Returns execution results.',
    inputSchema: z.object({
      strategy_id: identifier.describe('Strategy UUID to execute'),
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
    description: 'List a page of configured webhook subscriptions. Signing secrets are excluded.',
    inputSchema: z.object({ active: z.boolean().optional(), limit: pageLimit, offset: pageOffset }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const query: Record<string, string> = {};
    if (args.active !== undefined) query.active = String(args.active);
    if (args.limit !== undefined) query.limit = String(args.limit);
    if (args.offset !== undefined) query.offset = String(args.offset);
    const result = await callRestApi({ method: 'GET', path: '/webhooks', query, ...creds });
    return formatResult(result);
  });

  server.registerTool('create_webhook', {
    title: 'Create Webhook',
    description: 'Subscribe to platform events via webhook. Returns the signing secret (save it — shown once).',
    inputSchema: z.object({
      url: z.string().url().refine(value => new URL(value).protocol === 'https:', 'Webhook endpoint must use HTTPS').describe('HTTPS endpoint to receive events'),
      events: z.array(z.enum([
        'order.placed', 'order.filled',
        'strategy.executed',
        'backtest.completed',
        'risk.alert',
        'news.breaking',
      ])).min(1).describe('Events to subscribe to'),
      description: z.string().optional(),
    }),
    annotations: { readOnlyHint: false },
  }, async (args) => {
    const result = await callRestApi({ method: 'POST', path: '/webhooks', body: args, ...creds });
    return formatResult(result);
  });

  server.registerTool('delete_webhook', {
    title: 'Delete Webhook',
    description: 'Remove a webhook subscription.',
    inputSchema: z.object({ id: identifier.describe('Webhook UUID') }),
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const result = await callRestApi({ method: 'GET', path: '/me', ...creds });
    return formatResult(result);
  });
}

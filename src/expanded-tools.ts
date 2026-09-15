import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/server";
import { callRestApi } from './api-client.js';
import { formatResult } from './tool-result.js';

interface Credentials {
  apiKey: string;
  apiSecret: string;
  requestId?: string;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('Maximum records in this page (default 50, maximum 100).'),
  offset: z.number().int().min(0).optional().describe('Records to skip (default 0). Increase to retrieve another page.'),
  sort_order: z.enum(['asc', 'desc']).optional().describe('Sort direction (default desc).'),
};

const filterText = z.string().trim().min(1).max(200);
const entityId = z.string().uuid().optional().describe('Entity UUID. Requires active membership; omit for your personal book.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a valid calendar date');
const dateRange = {
  from: date.optional().describe('Inclusive start date (YYYY-MM-DD).'),
  to: date.optional().describe('Inclusive end date (YYYY-MM-DD); must be on or after from.'),
};

/** Read only resources that already exist on the authenticated REST API. */
export function registerExpandedTools(server: McpServer, creds: Credentials) {
  const list = async (path: string, args: Record<string, string | number | boolean | undefined>) => {
    if (typeof args.from === 'string' && typeof args.to === 'string' && args.from > args.to) {
      return formatResult({ ok: false, status: 400, data: { error: 'from must be on or before to.' } });
    }
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) query[key] = String(value);
    }
    return formatResult(await callRestApi({ method: 'GET', path, query, ...creds }));
  };

  const get = async (path: string, id: string) =>
    formatResult(await callRestApi({ method: 'GET', path: `${path}/${encodeURIComponent(id)}`, ...creds }));

  server.registerTool('list_data_files', {
    title: 'List Data Files',
    description: 'Discover your uploaded datasets and their schema metadata, row counts, file types, and processing status. Returns metadata, not file contents. Requires the data scope.',
    inputSchema: z.object({
      status: filterText.optional().describe('Exact processing status filter.'),
      file_type: filterText.optional().describe('Exact file type filter, as stored on the dataset.'),
      name: filterText.optional().describe('Case-insensitive partial match on the dataset name.'),
      ...pagination,
      sort_by: z.enum(['created_at', 'updated_at', 'name', 'file_size', 'rows_count']).optional().describe('Sort column (default created_at).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => list('/data-files', args));

  server.registerTool('get_data_file', {
    title: 'Get Data File',
    description: 'Get one uploaded dataset’s metadata, including column information and storage path. Does not download the file. Requires the data scope.',
    inputSchema: z.object({ id: z.string().uuid().describe('Data file UUID from list_data_files.') }),
    annotations: readOnlyAnnotations,
  }, async ({ id }) => get('/data-files', id));

  server.registerTool('get_backtest_result', {
    title: 'Get Backtest Result',
    description: 'Inspect one saved backtest run, including its configuration, result, code, and verification fields when available. Does not run a new backtest. Requires the strategies scope.',
    inputSchema: z.object({ id: z.string().uuid().describe('Backtest run UUID from get_backtest_results.') }),
    annotations: readOnlyAnnotations,
  }, async ({ id }) => get('/backtests', id));

  server.registerTool('get_order', {
    title: 'Get Order',
    description: 'Read one stored order record, including its reconciled status and fill fields. This is platform state, not a fresh broker query. Requires the orders scope.',
    inputSchema: z.object({ id: z.string().uuid().describe('Platform order record UUID from list_orders; not the broker order ID.') }),
    annotations: readOnlyAnnotations,
  }, async ({ id }) => get('/orders', id));

  server.registerTool('get_risk_snapshot', {
    title: 'Get Risk Snapshot',
    description: 'Inspect one saved portfolio risk snapshot and its recorded exposures, risk contributions, and analytics when available. Does not compute fresh risk. Requires trading_credentials or orders scope.',
    inputSchema: z.object({ id: z.string().uuid().describe('Risk snapshot UUID from list_risk_snapshots.') }),
    annotations: readOnlyAnnotations,
  }, async ({ id }) => get('/risk-snapshots', id));

  server.registerTool('list_deals', {
    title: 'List OTC Deals',
    description: 'List middle-office OTC deal records in your personal or entity book. LIVE status includes DRAFT and CONFIRMED deals. Requires trading_credentials or orders scope.',
    inputSchema: z.object({
      entity_id: entityId,
      fund: filterText.optional(),
      book: filterText.optional(),
      deal_id: filterText.optional().describe('Business deal identifier, not the database row UUID.'),
      product_kind: filterText.optional().describe('Exact product kind, as stored on the deal.'),
      status: filterText.optional().describe('Deal status, case-insensitive; LIVE includes DRAFT and CONFIRMED.'),
      ...pagination,
      sort_by: z.enum(['created_at', 'updated_at', 'trade_date', 'effective_date', 'termination_date', 'deal_id']).optional().describe('Sort column (default created_at).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => list('/deals', args));

  server.registerTool('list_lifecycle_events', {
    title: 'List OTC Lifecycle Events',
    description: 'Inspect scheduled OTC lifecycle events, their required inputs, dates, and processing status. Date filters apply to event_date. Requires trading_credentials or orders scope.',
    inputSchema: z.object({
      entity_id: entityId,
      deal_id: filterText.optional().describe('Business deal identifier.'),
      kind: filterText.optional().describe('Event kind, case-insensitive.'),
      status: filterText.optional().describe('Event status, case-insensitive.'),
      ...dateRange,
      ...pagination,
      sort_by: z.enum(['created_at', 'event_date', 'payment_date', 'deal_id']).optional().describe('Sort column (default created_at).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => list('/lifecycle-events', args));

  server.registerTool('list_cash_flows', {
    title: 'List OTC Cash Flows',
    description: 'Inspect recorded OTC cash flows and settlement state. Date filters apply to payment_date. amount_minor is an exact integer string; preserve its precision. Requires trading_credentials or orders scope.',
    inputSchema: z.object({
      entity_id: entityId,
      deal_id: filterText.optional().describe('Business deal identifier.'),
      fund: filterText.optional(),
      book: filterText.optional(),
      unsettled: z.boolean().optional().describe('Set true to return only cash flows without settled_at. False or omitted includes all.'),
      ...dateRange,
      ...pagination,
      sort_by: z.enum(['created_at', 'payment_date', 'settled_at', 'deal_id']).optional().describe('Sort column (default created_at).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => list('/cash-flows', args));

  server.registerTool('list_journal_entries', {
    title: 'List OTC Journal Entries',
    description: 'Inspect middle-office ledger entry headers and audit hashes. Date filters apply to entry_date. Returns headers, not journal line items or a balance calculation. Requires trading_credentials or orders scope.',
    inputSchema: z.object({
      entity_id: entityId,
      deal_id: filterText.optional().describe('Business deal identifier.'),
      ...dateRange,
      ...pagination,
      sort_by: z.enum(['created_at', 'entry_date', 'deal_id']).optional().describe('Sort column (default created_at).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => list('/journal-entries', args));

  server.registerTool('list_fund_periods', {
    title: 'List OTC Fund Periods',
    description: 'Inspect recorded fund accounting periods, NAV fields, subscriptions, redemptions, and P&L when available. Monetary minor-unit fields are exact integer strings; preserve their precision. Requires trading_credentials or orders scope.',
    inputSchema: z.object({
      entity_id: entityId,
      fund: filterText.optional(),
      status: filterText.optional().describe('Period status, case-insensitive.'),
      ...pagination,
      sort_by: z.enum(['created_at', 'period_start', 'period_end', 'fund']).optional().describe('Sort column (default created_at).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => list('/fund-periods', args));
}

/**
 * Declared output schemas.
 *
 * The envelope is a property of the REST adapter, not of each tool: every CRUD
 * read returns `{data, count?}` or `{data}`, and a delete returns `{message}`.
 * Declaring it once here keeps the 25 tool definitions from repeating the same
 * three shapes, and gives clients something to validate against, which is how
 * upstream drift becomes a loud failure instead of a plausible-looking object.
 *
 * Only shapes this server can actually guarantee are declared. The action
 * endpoints (execute_strategy, sync_portfolio, compute_risk, get_market_data,
 * get_bars) and the two writes that proxy to their own handlers (place_order,
 * create_connection) return whatever the downstream edge function returns, so
 * they declare nothing rather than promise a shape we do not control.
 *
 * The SDK skips output validation when a result carries isError, so the error
 * envelope `{error, code}` is unaffected.
 */
import { z } from 'zod';

/** One page of records, as returned by every CRUD list route. */
const listEnvelope = z.object({
  data: z.array(z.unknown()),
  count: z.number().int().optional(),
}).passthrough();

/** A single record, as returned by get-by-id and by the generic write routes. */
const recordEnvelope = z.object({
  data: z.unknown(),
}).passthrough();

/** Deletion acknowledgement. */
const messageEnvelope = z.object({
  message: z.string(),
}).passthrough();

export const OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  list_strategies: listEnvelope,
  get_backtest_results: listEnvelope,
  list_orders: listEnvelope,
  list_positions: listEnvelope,
  list_accounts: listEnvelope,
  list_connections: listEnvelope,
  list_risk_snapshots: listEnvelope,
  list_webhooks: listEnvelope,
  list_data_files: listEnvelope,
  list_deals: listEnvelope,
  list_lifecycle_events: listEnvelope,
  list_cash_flows: listEnvelope,
  list_journal_entries: listEnvelope,
  list_fund_periods: listEnvelope,

  get_strategy: recordEnvelope,
  get_data_file: recordEnvelope,
  get_backtest_result: recordEnvelope,
  get_order: recordEnvelope,
  get_risk_snapshot: recordEnvelope,
  get_profile: recordEnvelope,
  create_strategy: recordEnvelope,
  update_strategy: recordEnvelope,
  create_webhook: recordEnvelope,

  delete_webhook: messageEnvelope,
};

/**
 * Scope-aware tool discovery.
 *
 * The REST API enforces scopes on every call, but tools/list used to describe
 * the whole server to every credential. A key scoped to `data` was still shown
 * place_order, so a model would plan a workflow around tools that 403 the
 * moment it reaches them. The MCP spec permits the advertised tool set to vary
 * by the authorization presented on the request, because credentials are
 * per-request input rather than connection state, so the honest catalogue is
 * the one this key can actually call.
 *
 * Filtering is a discovery improvement, never an enforcement boundary: the
 * REST API remains the only thing that decides what a credential may touch.
 */
import { createHash } from 'node:crypto';
import { callRestApi } from './api-client.js';

/**
 * Scopes accepted per tool, mirroring RESOURCE_SCOPES in the REST API
 * (supabase/functions/rest-api/resources.ts). A tool needs ANY of them.
 * A tool absent from this map is never filtered out.
 */
export const TOOL_SCOPES: Record<string, string[]> = {
  list_strategies: ['strategies'],
  get_strategy: ['strategies'],
  create_strategy: ['strategies'],
  update_strategy: ['strategies'],
  get_backtest_results: ['strategies'],
  get_backtest_result: ['strategies'],
  list_orders: ['orders'],
  get_order: ['orders'],
  place_order: ['orders'],
  execute_strategy: ['orders'],
  list_accounts: ['trading_credentials'],
  list_positions: ['trading_credentials', 'orders'],
  sync_portfolio: ['trading_credentials', 'orders'],
  compute_risk: ['trading_credentials', 'orders'],
  list_risk_snapshots: ['trading_credentials', 'orders'],
  get_risk_snapshot: ['trading_credentials', 'orders'],
  list_deals: ['trading_credentials', 'orders'],
  list_lifecycle_events: ['trading_credentials', 'orders'],
  list_cash_flows: ['trading_credentials', 'orders'],
  list_journal_entries: ['trading_credentials', 'orders'],
  list_fund_periods: ['trading_credentials', 'orders'],
  list_data_files: ['data'],
  get_data_file: ['data'],
  get_market_data: ['data'],
  get_bars: ['data'],
  list_connections: ['data'],
  create_connection: ['data'],
  // Webhooks span every event family, so the REST API accepts any resource
  // scope. Identity-only tokens still hold none of them.
  list_webhooks: ['strategies', 'data', 'orders', 'trading_credentials', 'data_connections', 'storage', 'simons'],
  create_webhook: ['strategies', 'data', 'orders', 'trading_credentials', 'data_connections', 'storage', 'simons'],
  delete_webhook: ['strategies', 'data', 'orders', 'trading_credentials', 'data_connections', 'storage', 'simons'],
  // get_profile, search_tools and call_tool need no resource scope.
};

export function isAllowed(toolName: string, scopes: ReadonlySet<string>): boolean {
  const accepted = TOOL_SCOPES[toolName];
  if (!accepted) return true;
  return accepted.some(scope => scopes.has(scope));
}

// A discovery call must not wait out the default 20s API budget: a slow REST
// API should cost the caller an unfiltered tool list, not a stalled client.
const LOOKUP_TIMEOUT_MS = 3_000;
const TTL_MS = 60_000;
const SWEEP_MS = 300_000;
const MAX_ENTRIES = 1_000;

interface CacheEntry { scopes: Set<string>; expiresAt: number }
const cache = new Map<string, CacheEntry>();

/** Periodic sweep, so an idle process does not hold expired entries forever. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
}, SWEEP_MS);
sweep.unref?.();

/** Credentials are never used as a map key; only a digest of them is. */
function cacheKey(apiKey: string, apiSecret: string): string {
  return createHash('sha256').update(`${apiKey}:${apiSecret}`).digest('hex');
}

export function clearScopeCache() {
  cache.clear();
}

/**
 * The scopes this credential holds, or null when they cannot be determined.
 *
 * Null is not "no scopes" and must not be read as one: it means the lookup
 * failed, or the REST API predates the `scopes` field on /me. The caller then
 * advertises the full catalogue, which is the behaviour this server has always
 * had. The failure is logged rather than swallowed.
 */
export async function resolveScopes(
  apiKey: string,
  apiSecret: string,
  requestId?: string,
): Promise<Set<string> | null> {
  if (!apiKey || !apiSecret) return null;
  const key = cacheKey(apiKey, apiSecret);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.scopes;
  if (hit) cache.delete(key);

  const result = await callRestApi({
    method: 'GET', path: '/me', apiKey, apiSecret, requestId, timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  if (!result.ok) {
    console.error('[scopes] /me lookup failed; advertising the full tool catalogue', {
      status: result.status,
      request_id: requestId,
    });
    return null;
  }

  const raw = (result.data as { data?: { scopes?: unknown } } | null)?.data?.scopes;
  if (!Array.isArray(raw)) {
    // An older REST API deployment has no scopes field. Say so once per
    // lookup rather than silently behaving as though the key holds nothing.
    console.warn('[scopes] /me returned no scopes field; advertising the full tool catalogue', {
      request_id: requestId,
    });
    return null;
  }

  const scopes = new Set(raw.map(scope => String(scope).toLowerCase()));

  // Bound the cache: keys are credential digests, so an attacker spraying
  // credentials could otherwise grow it without limit. Oldest insertion goes
  // first, which is also the entry closest to expiry.
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, { scopes, expiresAt: Date.now() + TTL_MS });
  return scopes;
}

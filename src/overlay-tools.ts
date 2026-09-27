/**
 * Overlay strategies: read what an overlay hedges and how far it is from policy.
 *
 * An overlay is a strategy with strategy_role 'overlay' that hedges other
 * strategies or whole broker accounts under a hedge policy (objective, hedge
 * ratio, tolerance band, instruments, benchmark). Two platform routes serve it
 * to a caller holding an API key or one of this server's OAuth tokens:
 *
 *   - GET /cpz/overlay/exposure on the cpz gateway (strategies scope): the
 *     resolved exposure document, which also carries the targets and the
 *     policy's objective, ratio, band and benchmark.
 *   - GET /v1/strategies on the REST adapter: every row carries strategy_role,
 *     which is how overlays are found.
 *
 * Nothing on either route reads overlay_policies or overlay_targets directly,
 * so hedge_instruments, rebalance_trigger and notes are not visible here, and
 * nothing writes them: save_overlay_config is SECURITY INVOKER and needs a
 * user JWT, which this server never holds. There is deliberately no configure
 * tool until the platform has a user-scoped write route for it.
 */
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/server";
import { callRestApi, type ApiResult } from './api-client.js';
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

// The exposure resolver reads the ledger, broker positions, a price snapshot
// and, for beta and vol_target, a year of daily closes per symbol. cpz-py gives
// the same call 30 seconds; the default 20 second budget is too tight for a
// large book.
const EXPOSURE_TIMEOUT_MS = 30_000;

// Strategies are scanned in full to find the overlays, 100 per REST page. A
// book larger than this is refused rather than listed from a partial scan.
const STRATEGY_PAGE = 100;
const MAX_STRATEGY_PAGES = 20;

// Exposure reads run a few at a time so a page of overlays neither serialises
// behind the slowest nor fans out into the gateway's hourly request budget.
const EXPOSURE_CONCURRENCY = 3;

// The hedge fields the platform withholds when the book is incomplete.
const WITHHELD_FIELDS = ['current_ratio', 'drift', 'outside_band', 'suggested_order'] as const;

const UNAVAILABLE_POLICY_FIELDS = ['hedge_instruments', 'rebalance_trigger', 'notes'];

const CONFIGURE_GUIDANCE =
  'Overlays are configured in CPZAI Strategy Lab (Overlay tab). This server has no overlay write tool: save_overlay_config needs a signed-in user session, not an API credential.';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(status: number, code: string, error: string, extra: Json = {}) {
  return { ok: false, status, data: { error, code, ...extra } };
}

/** An exposure document this server can present, or the reason it cannot. */
type Exposure =
  | { ok: true; doc: Json & { complete: boolean; hedge: Json; targets: unknown[] } }
  | { ok: false; reason: string };

function readExposure(data: unknown): Exposure {
  if (!isObject(data)) return { ok: false, reason: 'the response was not a JSON object' };
  if (typeof data.complete !== 'boolean') return { ok: false, reason: 'the response carried no boolean complete flag' };
  if (!isObject(data.hedge)) return { ok: false, reason: 'the response carried no hedge block' };
  if (!Array.isArray(data.targets)) return { ok: false, reason: 'the response carried no targets list' };
  return { ok: true, doc: data as Json & { complete: boolean; hedge: Json; targets: unknown[] } };
}

/**
 * The hedge block with the ratio fields forced to null when the book is
 * incomplete. The platform already withholds them; this makes sure a drifted
 * upstream can never put a number from a partial book in front of a model, and
 * says so loudly if it tried.
 */
function withheldHedge(doc: { complete: boolean; hedge: Json }, context: Json): Json {
  const hedge = { ...doc.hedge };
  if (doc.complete) return hedge;
  const removed = WITHHELD_FIELDS.filter(field => hedge[field] !== null && hedge[field] !== undefined);
  for (const field of WITHHELD_FIELDS) hedge[field] = null;
  if (removed.length > 0) {
    console.error('[overlay] incomplete exposure carried hedge values; withheld them', { ...context, fields: removed });
  }
  return hedge;
}

function ratioStatus(complete: boolean, hedge: Json): 'measured' | 'not_measured' | 'withheld' {
  if (!complete) return 'withheld';
  return typeof hedge.current_ratio === 'number' && Number.isFinite(hedge.current_ratio) ? 'measured' : 'not_measured';
}

/** The platform's 409s point at save_overlay_config, which this server cannot call. */
function withGuidance(result: ApiResult): ApiResult {
  if (result.status !== 409 || !isObject(result.data)) return result;
  return { ...result, data: { ...result.data, guidance: CONFIGURE_GUIDANCE } };
}

function fetchExposure(strategyId: string, creds: Credentials) {
  return callRestApi({
    method: 'GET',
    api: 'gateway',
    path: '/overlay/exposure',
    query: { strategy_id: strategyId },
    timeoutMs: EXPOSURE_TIMEOUT_MS,
    ...creds,
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

const STRATEGY_FIELDS = ['title', 'status', 'strategy_type', 'allow_short', 'created_at', 'updated_at'];

/** Every overlay strategy the caller owns, from a full scan of /strategies. */
async function scanOverlays(creds: Credentials): Promise<{ ok: true; rows: Json[] } | { ok: false; result: ReturnType<typeof failure> | ApiResult }> {
  const overlays: Json[] = [];
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= MAX_STRATEGY_PAGES) {
      return {
        ok: false,
        result: failure(422, 'strategy_scan_too_large',
          `More than ${MAX_STRATEGY_PAGES * STRATEGY_PAGE} strategies: list_overlays cannot guarantee a complete scan, so it lists none. Use list_strategies and get_overlay_exposure instead.`),
      };
    }
    const result = await callRestApi({
      method: 'GET',
      path: '/strategies',
      // Oldest first, so a strategy created mid-scan lands on a later page
      // instead of shifting one already read onto the next.
      query: { limit: String(STRATEGY_PAGE), offset: String(page * STRATEGY_PAGE), sort_by: 'created_at', sort_order: 'asc' },
      ...creds,
    });
    if (!result.ok) return { ok: false, result };
    const rows = isObject(result.data) ? result.data.data : undefined;
    if (!Array.isArray(rows)) {
      return {
        ok: false,
        result: failure(502, 'invalid_upstream_response', 'The strategies list carried no data array; overlays cannot be listed from it.', { request_id: result.requestId }),
      };
    }
    for (const row of rows) {
      if (!isObject(row) || typeof row.id !== 'string') {
        return {
          ok: false,
          result: failure(502, 'invalid_upstream_response', 'A strategies row carried no id; overlays cannot be listed from it.', { request_id: result.requestId }),
        };
      }
      // A row without the column is not an alpha strategy; it is a platform
      // that cannot say. Listing zero overlays from it would be a guess.
      if (!('strategy_role' in row)) {
        return {
          ok: false,
          result: failure(502, 'strategy_role_unavailable',
            'The platform did not report strategy_role on strategies, so overlays cannot be told apart from alpha strategies.', { request_id: result.requestId }),
        };
      }
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.strategy_role === 'overlay') overlays.push(row);
    }
    if (rows.length < STRATEGY_PAGE) return { ok: true, rows: overlays };
  }
}

/** One overlay's configuration and hedge status, read from its exposure. */
async function describeOverlay(row: Json, creds: Credentials): Promise<Json> {
  const strategyId = row.id as string;
  const entry: Json = { strategy_id: strategyId };
  for (const field of STRATEGY_FIELDS) if (field in row) entry[field] = row[field];

  const result = await fetchExposure(strategyId, creds);
  const upstream = isObject(result.data) ? result.data : {};
  if (!result.ok) {
    // A policy or target list that does not exist yet is a state, not a
    // failure: the platform ran the read and found an unconfigured overlay.
    if (result.status === 409 && upstream.error === 'overlay_not_configured') {
      return {
        ...entry, configured: false, policy: null, targets: null, hedge: null,
        note: typeof upstream.message === 'string' ? upstream.message : 'The overlay has no hedge policy or targets yet.',
        guidance: CONFIGURE_GUIDANCE,
      };
    }
    return {
      ...entry, configured: null, policy: null, targets: null, hedge: null,
      error: {
        status: result.status,
        error: upstream.error ?? 'overlay_exposure_failed',
        ...(typeof upstream.message === 'string' ? { message: upstream.message } : {}),
        ...(upstream.code !== undefined ? { code: upstream.code } : {}),
        request_id: result.requestId,
      },
    };
  }

  const exposure = readExposure(result.data);
  if (!exposure.ok) {
    return {
      ...entry, configured: null, policy: null, targets: null, hedge: null,
      error: {
        status: 502,
        error: 'invalid_upstream_response',
        message: `The overlay exposure response could not be read: ${exposure.reason}.`,
        request_id: result.requestId,
      },
    };
  }

  const { doc } = exposure;
  const hedge = withheldHedge(doc, { request_id: result.requestId, strategy_id: strategyId });
  return {
    ...entry,
    configured: true,
    policy: {
      objective: hedge.objective ?? null,
      hedge_ratio: hedge.target_ratio ?? null,
      tolerance_band: hedge.tolerance_band ?? null,
      benchmark_symbol: doc.benchmark_symbol ?? null,
    },
    targets: doc.targets.map(target => {
      const t = isObject(target) ? target : {};
      return {
        kind: t.kind ?? null,
        strategy_id: t.strategy_id ?? null,
        account_key: t.account_key ?? null,
        broker: t.broker ?? null,
        environment: t.environment ?? null,
        weight: t.weight ?? null,
      };
    }),
    hedge: {
      complete: doc.complete,
      hedge_ratio_status: ratioStatus(doc.complete, hedge),
      current_ratio: hedge.current_ratio ?? null,
      drift: hedge.drift ?? null,
      outside_band: hedge.outside_band ?? null,
      reason: hedge.reason ?? null,
      as_of: doc.as_of ?? null,
    },
  };
}

export function registerOverlayTools(server: McpServer, creds: Credentials) {
  server.registerTool('get_overlay_exposure', {
    title: 'Get Overlay Exposure',
    description: 'Resolve one overlay strategy\'s hedge: what its targets (strategies or broker accounts) carry, what the overlay itself holds, the combined book, and how far the hedge is from policy (objective, target ratio, tolerance band, current ratio, drift, advisory suggested order), plus hedge effectiveness and base/overlay/combined P&L. When complete is false a price or price history is missing: the hedge ratio and suggested order are withheld (null), never estimated, and no hedge should be sized from the result. Read-only; places no order. Requires the strategies scope.',
    inputSchema: z.object({
      strategy_id: z.string().uuid().describe('Overlay strategy UUID, from list_overlays or list_strategies.'),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ strategy_id }) => {
    const result = await fetchExposure(strategy_id, creds);
    if (!result.ok) return formatResult(withGuidance(result));

    const exposure = readExposure(result.data);
    if (!exposure.ok) {
      console.error('[overlay] exposure response unreadable', { request_id: result.requestId, strategy_id, reason: exposure.reason });
      return formatResult(failure(502, 'invalid_upstream_response',
        `The overlay exposure response could not be read: ${exposure.reason}. No hedge reading is available.`,
        { request_id: result.requestId }));
    }

    const { doc } = exposure;
    const hedge = withheldHedge(doc, { request_id: result.requestId, strategy_id });
    // The verdict comes first so a reader meets it before the numbers.
    return formatResult({
      ok: true,
      status: 200,
      data: {
        complete: doc.complete,
        hedge_ratio_status: ratioStatus(doc.complete, hedge),
        hedge_ratio_reason: hedge.reason ?? null,
        ...(doc.complete ? {} : {
          withheld: {
            fields: WITHHELD_FIELDS.map(field => `hedge.${field}`),
            missing_prices: doc.missing_prices ?? [],
            missing_history: doc.missing_history ?? [],
            guidance: 'The platform could not price or measure the whole book, so it withheld the hedge ratio and the suggested order rather than compute them from part of it. Do not size or place a hedge from this result; resolve the missing data and read it again.',
          },
        }),
        data: { ...doc, hedge },
      },
    });
  });

  server.registerTool('list_overlays', {
    title: 'List Overlays',
    description: 'List your overlay strategies (strategies whose role is overlay) with their hedge configuration: targets (strategies or broker accounts, with weights), policy (objective, hedge ratio, tolerance band, benchmark), and current hedge status. The configuration comes from each overlay\'s exposure read, so a page of overlays costs one read per overlay and needs the platform market-data source; hedge_instruments, rebalance_trigger and notes are not exposed by any API route yet. total is the exact number of overlays. Requires the strategies scope.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(25).optional().describe('Overlays in this page (default 10, maximum 25). Each one costs an exposure read.'),
      offset: z.number().int().min(0).optional().describe('Overlays to skip (default 0). Increase by the returned count for the next page.'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => {
    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;

    const scan = await scanOverlays(creds);
    if (!scan.ok) return formatResult(scan.result);

    const page = scan.rows.slice(offset, offset + limit);
    const entries = await mapLimit(page, EXPOSURE_CONCURRENCY, row => describeOverlay(row, creds));
    const body = {
      data: entries,
      count: entries.length,
      total: scan.rows.length,
      offset,
      limit,
      unavailable_policy_fields: UNAVAILABLE_POLICY_FIELDS,
    };

    // An overlay whose configuration could not be read is unknown, not
    // unconfigured: the page is an error, with every entry still attached.
    const failed = entries.filter(entry => entry.error !== undefined);
    if (failed.length > 0) {
      console.error('[overlay] list_overlays could not read every overlay', {
        request_id: creds.requestId,
        failed: failed.map(entry => ({ strategy_id: entry.strategy_id, status: (entry.error as Json).status })),
      });
      return formatResult(failure(502, 'overlay_read_failed',
        `The configuration of ${failed.length} of ${entries.length} overlays could not be read; see data[].error. Their configuration is unknown, not empty.`,
        body));
    }
    return formatResult({ ok: true, status: 200, data: body });
  });
}

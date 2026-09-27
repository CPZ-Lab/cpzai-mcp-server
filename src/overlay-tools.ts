/**
 * Overlay strategies: list and configure them, and read how far each hedge is
 * from policy.
 *
 * An overlay is a strategy with strategy_role 'overlay' that hedges other
 * strategies or whole broker accounts under a hedge policy (objective, hedge
 * ratio, tolerance band, instruments, benchmark). Every route here is on the
 * cpz gateway, takes the caller's own X-CPZ-Key/X-CPZ-Secret and needs the
 * strategies scope:
 *
 *   - GET /cpz/overlays: every overlay with its policy and targets, straight
 *     from the tables (no market data).
 *   - PUT /cpz/overlays/{id}: role, policy and targets saved atomically for
 *     the key owner (save_overlay_config_as), then read back.
 *   - GET /cpz/overlay/exposure: the resolved exposure and hedge status, which
 *     needs prices and, for beta and vol_target, price history.
 */
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/server";
import { callRestApi, type ApiResult } from './api-client.js';
import { formatResult, invalidArguments } from './tool-result.js';

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

// The hedge fields the platform withholds when the book is incomplete.
const WITHHELD_FIELDS = ['current_ratio', 'drift', 'outside_band', 'suggested_order'] as const;

const CONFIGURE_GUIDANCE =
  'Make the strategy an overlay, or give it a hedge policy and targets, with configure_overlay (role overlay, a policy and at least one target). list_overlays shows the current configuration.';

const OBJECTIVES = ['beta', 'fx', 'duration', 'delta', 'vol_target', 'tail', 'custom'] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(status: number, code: string, error: string, extra: Json = {}) {
  return { ok: false, status, data: { error, code, ...extra } };
}

// ── Exposure ─────────────────────────────────────────────────────────────

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

/** The platform's 409s say the strategy is not (fully) an overlay yet. */
function withGuidance(result: ApiResult): ApiResult {
  if (result.status !== 409 || !isObject(result.data)) return result;
  return { ...result, data: { ...result.data, guidance: CONFIGURE_GUIDANCE } };
}

// ── Configuration input ──────────────────────────────────────────────────

const strategyId = z.string().uuid();
const symbol = z.string().trim().min(1).max(32)
  .regex(/^[A-Za-z0-9^][A-Za-z0-9./:_=^\-]*$/, 'Use a ticker symbol such as SPY')
  .transform(value => value.toUpperCase());
// Weight is the share of the target's exposure this overlay answers for; the
// database accepts (0, 10].
const weight = z.number().finite().gt(0).max(10).optional().describe('Share of the target\'s exposure this overlay hedges, greater than 0 and at most 10 (default 1).');

// Strict objects: a misspelt field must be refused, not dropped and replaced
// by the database default without anyone noticing.
const policySchema = z.strictObject({
  objective: z.enum(OBJECTIVES).describe('What the overlay neutralises. beta needs benchmark_symbol.'),
  hedge_ratio: z.number().finite().min(0).max(5).optional().describe('Target hedge ratio, 0 to 5; 1 fully offsets the objective\'s exposure (default 1).'),
  tolerance_band: z.number().finite().gt(0).max(1).optional().describe('Rebalance when |actual - target| / target exceeds this; greater than 0 and at most 1 (default 0.1).'),
  hedge_instruments: z.array(symbol).max(100).optional().describe('Symbols the overlay hedges with (default none).'),
  benchmark_symbol: symbol.optional().describe('Benchmark for beta; required when objective is beta.'),
  rebalance_trigger: z.enum(['band', 'schedule']).optional().describe('band or schedule (default band).'),
  notes: z.string().max(2000).optional(),
});

const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('strategy'),
    strategy_id: strategyId.describe('A strategy you own, other than the overlay itself.'),
    weight,
  }),
  z.strictObject({
    kind: z.literal('account'),
    account_key: z.string().trim().min(1).max(200).describe('Account id as list_accounts or list_positions reports it.'),
    broker: z.string().trim().min(1).max(64).describe('Broker of that account, e.g. alpaca, ibkr.'),
    environment: z.enum(['paper', 'live']),
    weight,
  }),
]);

type Policy = z.infer<typeof policySchema>;
type Target = z.infer<typeof targetSchema>;

/**
 * The rules the database enforces that a schema cannot express. The database
 * stays the authority (ownership, account membership and cycles are only
 * knowable there); this refuses the obvious cases before a write is sent.
 */
function configProblem(id: string, role: 'overlay' | 'alpha', policy: Policy | undefined, targets: Target[] | undefined): string | null {
  if (role === 'alpha') {
    if (policy !== undefined || targets !== undefined) {
      return 'role alpha removes the overlay\'s policy and targets; pass neither policy nor targets with it.';
    }
    return null;
  }
  if (!policy) return 'an overlay needs a policy (at least an objective).';
  if (!targets || targets.length === 0) return 'an overlay needs at least one target (a strategy or an account).';
  if (policy.objective === 'beta' && !policy.benchmark_symbol) return 'a beta overlay needs benchmark_symbol.';
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.kind === 'strategy' && target.strategy_id.toLowerCase() === id.toLowerCase()) {
      return 'an overlay cannot target itself.';
    }
    const key = target.kind === 'strategy'
      ? `strategy:${target.strategy_id.toLowerCase()}`
      : `account:${target.broker.trim().toLowerCase()}:${target.environment}:${target.account_key.trim()}`;
    if (seen.has(key)) return `the same target is listed twice (${key.replace(/^[^:]+:/, '')}).`;
    seen.add(key);
  }
  return null;
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerOverlayTools(server: McpServer, creds: Credentials) {
  server.registerTool('get_overlay_exposure', {
    title: 'Get Overlay Exposure',
    description: 'Resolve one overlay strategy\'s hedge: what its targets (strategies or broker accounts) carry, what the overlay itself holds, the combined book, and how far the hedge is from policy (objective, target ratio, tolerance band, current ratio, drift, advisory suggested order), plus hedge effectiveness and base/overlay/combined P&L. When complete is false a price or price history is missing: the hedge ratio and suggested order are withheld (null), never estimated, and no hedge should be sized from the result. Read-only; places no order. Requires the strategies scope.',
    inputSchema: z.object({
      strategy_id: strategyId.describe('Overlay strategy UUID, from list_overlays or list_strategies.'),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ strategy_id }) => {
    const result = await callRestApi({
      method: 'GET',
      api: 'gateway',
      path: '/overlay/exposure',
      query: { strategy_id },
      timeoutMs: EXPOSURE_TIMEOUT_MS,
      ...creds,
    });
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
    description: 'List your overlay strategies with their full configuration: policy (objective, hedge ratio, tolerance band, hedge instruments, benchmark, rebalance trigger, notes) and targets (strategies or broker accounts, with weights). configured is true when an overlay has a policy and at least one target. One read, no market data; for hedge status and drift use get_overlay_exposure. The platform returns at most 200 overlays, ordered by title; truncated says whether more exist. Requires the strategies scope.',
    inputSchema: z.object({}),
    annotations: readOnlyAnnotations,
  }, async () => {
    const result = await callRestApi({ method: 'GET', api: 'gateway', path: '/overlays', ...creds });
    if (!result.ok) return formatResult(result);
    const body = isObject(result.data) ? result.data : {};
    if (!Array.isArray(body.overlays) || typeof body.truncated !== 'boolean') {
      console.error('[overlay] overlay list unreadable', { request_id: result.requestId });
      return formatResult(failure(502, 'invalid_upstream_response',
        'The overlay list carried no overlays array or no truncated flag; it cannot be presented as your overlays.',
        { request_id: result.requestId }));
    }
    return formatResult({
      ok: true,
      status: 200,
      data: {
        data: body.overlays,
        count: body.overlays.length,
        truncated: body.truncated,
        ...(body.truncated ? {
          note: `The platform returned its first ${body.overlays.length} overlays by title and more exist. This is not the complete list.`,
        } : {}),
      },
    });
  });

  server.registerTool('configure_overlay', {
    title: 'Configure Overlay',
    description: 'Make a strategy an overlay, or change or remove its overlay configuration, in one atomic write. role overlay needs a policy and at least one target, and REPLACES the whole policy and target list: policy fields you omit take their defaults (hedge_ratio 1, tolerance_band 0.1, rebalance_trigger band, no hedge instruments, no notes) and targets you do not list are removed, so read list_overlays first when changing one field. role alpha removes the policy and targets and makes it an ordinary strategy again. Becoming an overlay turns short selling on for the strategy. Places no order, but changes what the overlay hedges from its next run. Requires the strategies scope.',
    inputSchema: z.object({
      strategy_id: strategyId.describe('Strategy UUID to configure, from list_strategies or list_overlays.'),
      role: z.enum(['overlay', 'alpha']).describe('overlay to set a policy and targets; alpha to remove them.'),
      policy: policySchema.optional().describe('Required for role overlay; omit for role alpha.'),
      targets: z.array(targetSchema).max(100).optional().describe('Required for role overlay (at least one); omit for role alpha. Replaces the current targets.'),
    }),
    // It replaces the policy and the target list wholesale, so it can remove
    // configuration; the same call repeated leaves the same configuration.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ strategy_id, role, policy, targets }) => {
    const problem = configProblem(strategy_id, role, policy, targets);
    if (problem) return invalidArguments(problem);

    const result = await callRestApi({
      method: 'PUT',
      api: 'gateway',
      path: `/overlays/${strategy_id}`,
      body: role === 'alpha' ? { role } : { role, policy, targets },
      ...creds,
    });
    if (!result.ok) {
      console.error('[overlay] configure_overlay failed', {
        request_id: result.requestId,
        strategy_id,
        role,
        status: result.status,
        error: isObject(result.data) ? result.data.error : undefined,
      });
      return formatResult(result);
    }

    // A 200 is the platform saying the transaction committed. Anything else
    // in its place is not proof of a save, so it is reported as unconfirmed.
    const body = isObject(result.data) ? result.data : null;
    if (!body || !isObject(body.saved) || !('overlay' in body)) {
      console.error('[overlay] configure_overlay returned an unreadable 200', { request_id: result.requestId, strategy_id });
      return formatResult(failure(502, 'invalid_upstream_response',
        'The platform answered the save with a response this server cannot read, so whether the configuration was saved is unconfirmed.',
        {
          request_id: result.requestId,
          operation_outcome: 'unknown',
          guidance: 'Check the configuration with list_overlays before saving again.',
        }));
    }
    if (body.overlay === null) {
      // Saved, but the read-back failed: the save stands and says so.
      return formatResult({
        ok: true,
        status: 200,
        data: {
          ...body,
          note: 'The configuration was saved, but the platform could not read it back. Confirm it with list_overlays.',
        },
      });
    }
    return formatResult({ ok: true, status: 200, data: body });
  });
}

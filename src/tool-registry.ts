/**
 * Tool capture and search, so the server can advertise a small surface and let
 * a client discover the rest on demand.
 *
 * `registerTools` and `registerExpandedTools` write straight onto an McpServer.
 * That is the right shape for the full catalogue, but progressive discovery
 * needs the definitions as DATA (a searchable index and a dispatcher) before
 * deciding which of them reach `tools/list`. `captureTools` runs the same
 * registration functions against a recorder, so there is exactly one definition
 * of every tool and no second list to drift.
 */
import { z } from 'zod';
import { OUTPUT_SCHEMAS } from './tool-output.js';
import type { McpServer, CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import type { ZodType } from 'zod';

// The target the v2 server itself converts with, so a schema handed out by
// search_tools is byte-identical to the one tools/list publishes.
const JSON_SCHEMA_TARGET = 'draft-2020-12' as const;

function toJsonSchema(schema: ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io }) as Record<string, unknown>;
}

export interface CapturedToolConfig {
  title?: string;
  description?: string;
  inputSchema?: ZodType;
  outputSchema?: ZodType;
  annotations?: ToolAnnotations;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => CallToolResult | Promise<CallToolResult>;

export interface CapturedTool {
  name: string;
  config: CapturedToolConfig;
  handler: ToolHandler;
}

/** Run a registration function against a recorder instead of a live server. */
export function captureTools(register: (server: McpServer) => void): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const recorder = {
    registerTool(name: string, config: CapturedToolConfig, handler: ToolHandler) {
      captured.push({ name, config, handler });
      return undefined;
    },
    // Capture is tools-only; a registration function that also declared
    // resources or prompts would silently lose them, so fail loudly instead.
    registerResource() {
      throw new Error('captureTools records tools only; register resources on the server directly');
    },
    registerPrompt() {
      throw new Error('captureTools records tools only; register prompts on the server directly');
    },
  } as unknown as McpServer;
  register(recorder);
  return captured;
}

/** The tool's config with its declared output envelope attached, if it has one. */
export function withOutputSchema(tool: CapturedTool): CapturedToolConfig {
  const outputSchema = OUTPUT_SCHEMAS[tool.name];
  return outputSchema ? { ...tool.config, outputSchema } : tool.config;
}

/** Replay captured tools onto a real server, in capture order. */
export function advertise(server: McpServer, tools: CapturedTool[]) {
  for (const tool of tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(tool.name, withOutputSchema(tool), tool.handler);
  }
}

export function isReadOnly(tool: CapturedTool): boolean {
  return tool.config.annotations?.readOnlyHint === true;
}

/**
 * The same JSON Schema the SDK would publish for this tool in `tools/list`.
 * Search results carry it verbatim so a client can call a discovered tool
 * without a second round trip to fetch its schema.
 */
export function inputJsonSchema(tool: CapturedTool): Record<string, unknown> {
  const schema = tool.config.inputSchema;
  if (!schema) return { type: 'object', additionalProperties: false };
  return toJsonSchema(schema, 'input');
}

/** Coarse grouping, used for filtering searches and for listing what exists. */
export const TOOL_CATEGORIES = [
  'strategies',
  'backtests',
  'orders',
  'positions',
  'accounts',
  'market-data',
  'risk',
  'data',
  'webhooks',
  'middle-office',
  'profile',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  list_strategies: 'strategies',
  get_strategy: 'strategies',
  create_strategy: 'strategies',
  update_strategy: 'strategies',
  execute_strategy: 'strategies',
  get_backtest_results: 'backtests',
  get_backtest_result: 'backtests',
  list_orders: 'orders',
  get_order: 'orders',
  place_order: 'orders',
  list_positions: 'positions',
  sync_portfolio: 'positions',
  list_accounts: 'accounts',
  get_market_data: 'market-data',
  get_bars: 'market-data',
  compute_risk: 'risk',
  list_risk_snapshots: 'risk',
  get_risk_snapshot: 'risk',
  list_connections: 'data',
  create_connection: 'data',
  list_data_files: 'data',
  get_data_file: 'data',
  list_webhooks: 'webhooks',
  create_webhook: 'webhooks',
  delete_webhook: 'webhooks',
  list_deals: 'middle-office',
  list_lifecycle_events: 'middle-office',
  list_cash_flows: 'middle-office',
  list_journal_entries: 'middle-office',
  list_fund_periods: 'middle-office',
  get_profile: 'profile',
};

export function categoryOf(name: string): ToolCategory | undefined {
  return CATEGORY_BY_TOOL[name];
}

/**
 * Searchable text for one tool: name, title, description, and, as the tool
 * search tool in the Claude API does, parameter names and their descriptions,
 * so "unsettled" or "entity_id" finds the tool that takes them.
 */
function haystack(tool: CapturedTool): { name: string; label: string; body: string } {
  const schema = inputJsonSchema(tool);
  const properties = (schema.properties ?? {}) as Record<string, { description?: string }>;
  const params = Object.entries(properties)
    .map(([key, value]) => `${key} ${value?.description ?? ''}`)
    .join(' ');
  return {
    name: tool.name.toLowerCase(),
    label: (tool.config.title ?? '').toLowerCase(),
    body: `${tool.config.description ?? ''} ${params}`.toLowerCase(),
  };
}

// Underscores are separators, not word characters: a model searching for
// "list_bars" or "entity_id" should reach get_bars and the tools that take an
// entity id, which a single-token match never would.
const TERM = /[a-z0-9]+/g;

/**
 * Term-frequency scoring over name, title and body, weighted so a hit in the
 * tool's own name outranks a passing mention in someone else's description.
 * A query that tokenizes to nothing (punctuation only) matches nothing rather
 * than returning an arbitrary slice of the catalogue.
 */
export function searchTools(
  tools: CapturedTool[],
  query: string,
  options: { limit?: number; category?: ToolCategory } = {},
): CapturedTool[] {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 25);
  const pool = options.category
    ? tools.filter(tool => categoryOf(tool.name) === options.category)
    : tools;

  const terms = [...query.toLowerCase().matchAll(TERM)].map(match => match[0]).filter(term => term.length > 1);
  // An empty query with a category filter is a legitimate "what is in here?";
  // an empty query with no filter is not, and returning the whole catalogue
  // would defeat the point of deferring it.
  if (terms.length === 0) return options.category ? pool.slice(0, limit) : [];

  const scored = pool
    .map(tool => {
      const fields = haystack(tool);
      let score = 0;
      for (const term of terms) {
        if (fields.name.includes(term)) score += 4;
        if (fields.label.includes(term)) score += 2;
        const occurrences = fields.body.split(term).length - 1;
        if (occurrences > 0) score += Math.min(occurrences, 3);
      }
      return { tool, score };
    })
    .filter(entry => entry.score > 0);

  // Stable within a score band: ties resolve by catalogue order, so the same
  // query returns the same tools in the same order on every request.
  scored.sort((a, b) => b.score - a.score || tools.indexOf(a.tool) - tools.indexOf(b.tool));
  return scored.slice(0, limit).map(entry => entry.tool);
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  category?: ToolCategory;
  read_only: boolean;
  callable_via: 'call_tool' | 'direct';
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export function describeTool(tool: CapturedTool): ToolDescriptor {
  const readOnly = isReadOnly(tool);
  return {
    name: tool.name,
    ...(tool.config.title !== undefined ? { title: tool.config.title } : {}),
    ...(tool.config.description !== undefined ? { description: tool.config.description } : {}),
    ...(categoryOf(tool.name) !== undefined ? { category: categoryOf(tool.name) } : {}),
    read_only: readOnly,
    callable_via: readOnly ? 'call_tool' : 'direct',
    input_schema: inputJsonSchema(tool),
    // A discovered tool should arrive with the same contract tools/list would
    // have given it, output shape included.
    ...(OUTPUT_SCHEMAS[tool.name]
      ? {
        output_schema: toJsonSchema(OUTPUT_SCHEMAS[tool.name], 'output'),
      }
      : {}),
  };
}

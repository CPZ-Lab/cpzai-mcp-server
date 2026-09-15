/**
 * Progressive tool discovery.
 *
 * The full catalogue is ~31 tools and ~27 KB of JSON Schema. Every client that
 * cannot defer tool loading pays that on every request, and tool-selection
 * accuracy degrades once a model is choosing between more than about thirty
 * tools. Compact mode advertises a small surface (the two tools below, the
 * everyday read anchors, and every state-changing tool) and lets the model
 * find the rest with `search_tools` and call them through `call_tool`.
 *
 * `call_tool` dispatches READ-ONLY tools only. A client gates approval on the
 * tool name it can see, so routing an order through a generic dispatcher would
 * hide it from exactly the check that is supposed to catch it. Every tool that
 * writes (orders, strategy execution, credentials, webhooks) stays a
 * first-class tool in every mode, visible by name before it is approved.
 *
 * Claude clients that support `defer_loading` (the MCP connector's
 * `mcp_toolset.default_config`, or Claude Code's own tool search) should use
 * the full endpoint with deferral instead: the API expands tool definitions
 * inline and preserves the cached prompt prefix. Compact mode is for the
 * clients that have no such mechanism.
 */
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/server";
import { formatResult, invalidArguments } from './tool-result.js';
import {
  TOOL_CATEGORIES,
  type CapturedTool,
  type ToolCategory,
  categoryOf,
  describeTool,
  isReadOnly,
  searchTools,
} from './tool-registry.js';

/**
 * Kept loaded in compact mode. These are the reads that start almost every
 * session, so deferring them would cost a search round trip on the common path.
 */
export const COMPACT_ANCHORS = new Set([
  'list_accounts',
  'list_positions',
  'list_orders',
  'get_market_data',
]);

/** Tools advertised in `tools/list` for the given mode. */
export function advertisedTools(tools: CapturedTool[], mode: 'full' | 'compact'): CapturedTool[] {
  if (mode === 'full') return tools;
  return tools.filter(tool => !isReadOnly(tool) || COMPACT_ANCHORS.has(tool.name));
}

/** Tools reachable only through search plus `call_tool` in the given mode. */
export function deferredTools(tools: CapturedTool[], mode: 'full' | 'compact'): CapturedTool[] {
  const advertised = new Set(advertisedTools(tools, mode).map(tool => tool.name));
  return tools.filter(tool => !advertised.has(tool.name));
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerToolSearch(server: McpServer, tools: CapturedTool[]) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const deferred = deferredTools(tools, 'compact');
  const deferredNames = new Set(deferred.map(tool => tool.name));

  server.registerTool('search_tools', {
    title: 'Search CPZAI Tools',
    description:
      `Find the CPZAI tools for a task and get their full input schemas. This server advertises its state-changing tools and the everyday reads up front; ${deferred.length} further read-only tools load on demand through this search. Searches tool names, titles, descriptions, parameter names, and parameter descriptions. Categories: ${TOOL_CATEGORIES.join(', ')}. Call the returned tool with call_tool. Searching does not read any account data.`,
    inputSchema: z.object({
      query: z.string().trim().max(500).optional().describe('What you are trying to do, in natural language or keywords (e.g. "unsettled cash flows", "historical bars"). Omit only when filtering by category.'),
      category: z.enum(TOOL_CATEGORIES).optional().describe('Restrict to one category; with no query this lists that category.'),
      limit: z.number().int().min(1).max(25).optional().describe('Maximum tools to return (default 5, maximum 25).'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => {
    const query = args.query ?? '';
    if (!query && !args.category) {
      return invalidArguments('Provide a query, a category, or both.');
    }
    const matches = searchTools(tools, query, {
      limit: args.limit,
      category: args.category as ToolCategory | undefined,
    });
    return formatResult({
      ok: true,
      status: 200,
      data: {
        query: query || null,
        category: args.category ?? null,
        count: matches.length,
        // A search that matches nothing is a result, not an error: the model
        // should widen the query rather than conclude the capability is absent.
        tools: matches.map(tool => describeTool(tool)),
        ...(matches.length === 0
          ? { note: 'No tool matched. Try broader keywords or a category from the tool description.' }
          : {}),
      },
    });
  });

  server.registerTool('call_tool', {
    title: 'Call a Discovered Tool',
    description:
      'Invoke a read-only CPZAI tool discovered with search_tools, passing its arguments exactly as its input_schema describes. Read-only tools only: tools that place orders, execute strategies, or write credentials and webhooks are advertised under their own names and must be called directly so you and the user see what is being approved. Returns the tool\'s own result unchanged.',
    inputSchema: z.object({
      name: z.string().trim().min(1).max(128).describe('Tool name exactly as returned by search_tools.'),
      arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments object matching that tool\'s input_schema. Omit for a tool that takes none.'),
    }),
    annotations: readOnlyAnnotations,
  }, async (args) => {
    const tool = byName.get(args.name);
    if (!tool) {
      const suggestions = searchTools(tools, args.name, { limit: 5 }).map(match => match.name);
      return formatResult({
        ok: false,
        status: 404,
        data: {
          error: `Unknown tool: ${args.name}`,
          code: 'unknown_tool',
          ...(suggestions.length > 0 ? { did_you_mean: suggestions } : {}),
        },
      });
    }

    if (!isReadOnly(tool)) {
      return formatResult({
        ok: false,
        status: 403,
        data: {
          error: `${tool.name} changes state and is not dispatchable through call_tool. It is advertised as its own tool: call ${tool.name} directly.`,
          code: 'not_dispatchable',
        },
      });
    }

    // Belt and braces: a read-only tool that is already advertised should be
    // called by name, so the client's own logging and approval see it.
    if (!deferredNames.has(tool.name)) {
      return formatResult({
        ok: false,
        status: 400,
        data: {
          error: `${tool.name} is already available as its own tool: call ${tool.name} directly.`,
          code: 'call_directly',
        },
      });
    }

    const schema = tool.config.inputSchema;
    const parsed = schema
      ? (schema as z.ZodTypeAny).safeParse(args.arguments ?? {})
      : ({ success: true, data: {} } as const);
    if (!parsed.success) {
      return formatResult({
        ok: false,
        status: 400,
        data: {
          error: `Invalid arguments for ${tool.name}`,
          code: 'invalid_arguments',
          issues: (parsed.error as z.ZodError).issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          input_schema: describeTool(tool).input_schema,
        },
      });
    }

    return tool.handler(parsed.data as Record<string, unknown>);
  });
}

export { categoryOf };

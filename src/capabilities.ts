import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const BASE_INSTRUCTIONS = `CPZAI provides user-scoped trading and research tools. Use tools/list for the current catalog and read cpzai://guides/tool-usage and cpzai://guides/permissions before planning a workflow. Paginate list results; a page is not the entire portfolio. Read-only review does not require order submission or strategy execution. execute_strategy can place real orders. Inspect account environment and tradable status before any user-authorized trading. A failed or timed-out mutation can have an unknown outcome: reconcile orders before considering another submission. Never infer zero positions, prices, or risk from an error or missing data.`;

const COMPACT_INSTRUCTIONS = `This endpoint advertises a compact surface. tools/list carries every state-changing tool plus the everyday reads; the remaining read-only tools load on demand. Call search_tools to find them; it returns each match with its full input schema. Then invoke the match with call_tool. call_tool dispatches read-only tools only; anything that places orders, executes strategies, or writes credentials or webhooks is advertised under its own name and must be called directly. Read cpzai://guides/discovery for the categories and the search conventions. An empty search result means no tool matched that wording, never that the capability is absent.`;

/** Server instructions, which differ by endpoint: see ToolMode in server.ts. */
export function serverInstructions(mode: 'full' | 'compact' = 'full'): string {
  return mode === 'compact' ? `${BASE_INSTRUCTIONS}\n\n${COMPACT_INSTRUCTIONS}` : BASE_INSTRUCTIONS;
}

const TOOL_USAGE = `# CPZAI tool usage

Discover the server's registered schemas with tools/list. Successful results include structuredContent and an equivalent JSON text block. Tool failures set isError; inspect error, code, and request_id when present.

## Pagination and data provenance
Most list tools accept limit (1–100, default 50) and offset (default 0). Advance offset by the number of returned records and continue until a page shorter than the requested limit. A count is the current page size, not the total. Lists are live views: concurrent writes can change pages. list_accounts defaults to 100; the other list tools default to 50. Use an explicit limit for consistent paging. get_bars uses a separate limit of 1–10000 bars per symbol. Preserve provider timestamps and currency units; middle-office minor-unit amounts are strings to preserve integer precision. Never replace missing or failed data with zeros.

## Research and inspection
Use list_data_files and get_data_file to discover stored metadata, columns, and existing previews. These tools do not download raw files or guarantee a five-row sample. Use get_strategy for stored code, get_backtest_results followed by get_backtest_result for stored runs, and get_order/get_risk_snapshot for individual records. Stored backtests are not a new backtest run.

## Trading and recovery
Start with list_accounts; select a tradable account and confirm its environment matches the user's intent. place_order requires a positive quantity, price for limit/stop_limit, and stop_price for stop/stop_limit. Broker stop-order support varies. Only day duration is exposed because it is supported consistently across routes. execute_strategy executes code and can trade; it is not a read-only signal or dry-run tool. A user-authorized workflow should not automatically place another order after execution.

The adapter never retries POST, PATCH, PUT, or DELETE. An unconfirmed mutation may have reached the platform or broker. Inspect orders and broker state before any resubmission; an empty local order page is not proof that a broker order failed. There is no end-to-end idempotent order retry guarantee on this interface.

## Capability boundaries
No generic HTTP/SQL tool, order cancellation, sandbox dry_run, apply_patch, SDK lookup, or execution-log tool is exposed. Use only tools returned by tools/list. Resources and prompts provide guidance; they do not execute trades or grant additional permissions.
`;

const PERMISSIONS = `# CPZAI credentials and permissions

Connect to https://mcp.cpz-lab.com/mcp over stateless Streamable HTTP using OAuth or X-CPZ-Key and X-CPZ-Secret. The REST API validates credentials and enforces user ownership, scopes, and applicable subscription checks on each data operation. Tool discovery describes the full server surface; it is not proof that a particular key can call every tool.

| Tools | Accepted resource scopes (any listed) |
| --- | --- |
| Strategy management and backtest reads | strategies |
| Data files, connections, quotes, historical bars | data |
| Account listing | trading_credentials |
| Orders and strategy execution | orders |
| Positions, risk, portfolio sync, middle-office reads | trading_credentials or orders |
| Webhooks | Any recognized resource scope |
| Profile | Authenticated identity |

Legacy read/write/trade scopes are expanded by the REST API. A scope is a resource permission; it is not a client approval policy. Do not put broker/provider secrets into prompts. create_connection sends supplied credentials to the platform for encrypted storage; list_connections never returns them. create_webhook returns its signing secret once; store it securely.

Middle-office reads default to personal scope. Supplying entity_id selects an organization only after active membership verification. Monetary amounts returned as strings must remain exact. A 401 requires valid authentication, 403 indicates insufficient permission, and provider or platform failures must remain visible.
`;

const DISCOVERY = `# CPZAI tool discovery

Two endpoints serve the same tools with different discovery models.

## https://mcp.cpz-lab.com/mcp (full catalogue)
Every tool appears in tools/list. Use this endpoint when the client defers tool loading itself. With Claude's MCP connector, set \`defer_loading\` once on the toolset and pair it with the tool search tool:

\`\`\`json
{"type": "mcp_toolset", "mcp_server_name": "cpzai", "default_config": {"defer_loading": true},
 "configs": {"list_accounts": {"defer_loading": false}, "list_positions": {"defer_loading": false}}}
\`\`\`

Deferred definitions are still sent on every request; they are kept out of the model's context until a search discovers them, and the prompt prefix is not disturbed, so the cache survives.

## https://mcp.cpz-lab.com/mcp/compact (server-side progressive discovery)
tools/list carries every state-changing tool, the read anchors (list_accounts, list_positions, list_orders, get_market_data), and two discovery tools. Use this endpoint when the client has no deferral mechanism of its own.

- \`search_tools\` takes a natural-language query and/or a category and returns matching tools with their full input schemas. Categories: strategies, backtests, orders, positions, accounts, market-data, risk, data, webhooks, middle-office, profile. Search covers tool names, titles, descriptions, parameter names, and parameter descriptions, so searching for a field name such as \`entity_id\` or \`unsettled\` finds the tool that accepts it.
- \`call_tool\` invokes a discovered tool by name with an arguments object matching its input_schema. It refuses anything that is not read-only, and refuses a read-only tool that is already advertised: call that one by name.

Results from call_tool are the tool's own result, unchanged: same structuredContent, same isError semantics.

## Conventions on both endpoints
Tool names, arguments, results, pagination, and scopes are identical. Discovery never reads account data and never places an order. A tool present in tools/list is not proof the caller's key holds the scope for it; see cpzai://guides/permissions.
`;

export function registerCapabilities(server: McpServer) {
  for (const [name, uri, title, text] of [
    ['tool-usage', 'cpzai://guides/tool-usage', 'CPZAI Tool Usage', TOOL_USAGE],
    ['permissions', 'cpzai://guides/permissions', 'CPZAI Permissions', PERMISSIONS],
    ['discovery', 'cpzai://guides/discovery', 'CPZAI Tool Discovery', DISCOVERY],
  ]) {
    server.registerResource(name, uri, { title, description: title, mimeType: 'text/markdown' }, async resourceUri => ({
      contents: [{ uri: resourceUri.href, mimeType: 'text/markdown', text }],
    }));
  }

  server.registerPrompt('review_portfolio', {
    title: 'Review Portfolio',
    description: 'Read-only portfolio review using accounts, paginated positions, orders, and stored risk snapshots.',
    argsSchema: { account_id: z.string().trim().min(1).optional().describe('Optional account filter') },
  }, ({ account_id }) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text:
      `Review my portfolio${account_id ? ` for account ${JSON.stringify(account_id)}` : ''}. Read cpzai://guides/tool-usage. List accounts, retrieve all pages of positions and relevant stored risk snapshots, and examine orders as permitted. Report account environments, timestamps, exposure, and missing or failed inputs. Keep currency amounts exact. This request is read-only; do not compute new snapshots, sync accounts, execute strategies, or submit orders.` } }],
  }));

  server.registerPrompt('analyze_strategy', {
    title: 'Analyze Strategy',
    description: 'Inspect stored strategy code and backtest evidence without execution or edits.',
    argsSchema: { strategy_id: z.string().uuid().describe('Strategy UUID') },
  }, ({ strategy_id }) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text:
      `Analyze strategy ${strategy_id}. Read its code with get_strategy, page through get_backtest_results for this strategy, and inspect relevant get_backtest_result records. If data inputs need investigation, use list_data_files/get_data_file and list_connections. Evaluate the actual stored evidence, call out missing data and failed requests, and propose improvements. This request authorizes analysis only; do not update or execute the strategy, create connections, or place trades.` } }],
  }));
}

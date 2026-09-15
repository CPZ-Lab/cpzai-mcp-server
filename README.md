# CPZAI MCP Server

A Model Context Protocol adapter for [CPZAI](https://ai.cpz-lab.com): strategies, saved backtests, broker accounts, orders, portfolio positions, market data, risk, provider connections, and middle-office reporting.

**Hosted endpoint:** `https://mcp.cpz-lab.com/mcp`
**Transport:** stateless Streamable HTTP
**Current source:** version 1.2.0 — 31 tools, two guide resources, two workflow prompts.

This README describes the updated source, not a completed production deployment. Use your connected client's `tools/list`, `resources/list`, and `prompts/list` to verify deployed capabilities. The previous source registered 21 tools; old references to 18 tools or a proposed 29-tool release were inaccurate.

## Connect

Create a key and secret in **Settings → API Keys** at [CPZAI](https://ai.cpz-lab.com). In a client supporting remote MCP with custom headers, configure:

```json
{
  "mcpServers": {
    "cpzai": {
      "url": "https://mcp.cpz-lab.com/mcp",
      "headers": {
        "X-CPZ-Key": "YOUR_KEY",
        "X-CPZ-Secret": "YOUR_SECRET"
      }
    }
  }
}
```

Use your client's equivalent connector settings when its configuration format differs. OAuth-capable clients can connect to the same MCP URL and complete sign-in using PKCE S256. Discovery endpoints:

- `https://mcp.cpz-lab.com/.well-known/oauth-authorization-server`
- `https://mcp.cpz-lab.com/.well-known/oauth-protected-resource`

OAuth access tokens are opaque and accepted by this server. Do not pass them directly to the REST API. Legacy `Bearer cpz_key_…SECRET` credentials are disabled by default; use header authentication or OAuth.

## Tool catalog

| Domain | Tool | Purpose |
|---|---|---|
| Strategies | `list_strategies` | status, strategy_type, title |
| Strategies | `get_strategy` | Read one strategy |
| Strategies | `create_strategy` | Create a strategy |
| Strategies | `update_strategy` | Update selected strategy fields |
| Backtests | `get_backtest_results` | List saved backtest runs |
| Backtests | `get_backtest_result` | Read one saved backtest run |
| Orders | `list_orders` | status, symbol, side, strategy_id |
| Orders | `get_order` | Read one CPZ order record |
| Orders | `place_order` | Submit an order to the selected connected account |
| Portfolio | `list_positions` | account_id, symbol |
| Portfolio | `sync_portfolio` | Synchronize connected broker portfolios |
| Accounts | `list_accounts` | broker, environment, tradable |
| Connections | `list_connections` | connection_type |
| Connections | `create_connection` | Store an encrypted provider credential |
| Data files | `list_data_files` | name, status, file_type |
| Data files | `get_data_file` | Read uploaded file metadata |
| Market data | `get_market_data` | Fetch current quotes for symbols |
| Market data | `get_bars` | Fetch historical OHLCV bars |
| Risk | `compute_risk` | Compute and store a fresh risk snapshot |
| Risk | `list_risk_snapshots` | account_id |
| Risk | `get_risk_snapshot` | Read one saved risk snapshot |
| Execution | `execute_strategy` | Execute strategy code; may place orders |
| Middle office | `list_deals` | entity_id, fund, book, deal_id, product_kind, status |
| Middle office | `list_lifecycle_events` | entity_id, deal_id, kind, status, from, to |
| Middle office | `list_cash_flows` | entity_id, deal_id, fund, book, from, to, unsettled |
| Middle office | `list_journal_entries` | entity_id, deal_id, from, to |
| Middle office | `list_fund_periods` | entity_id, fund, status |
| Webhooks | `list_webhooks` | active |
| Webhooks | `create_webhook` | Subscribe an HTTPS endpoint to events |
| Webhooks | `delete_webhook` | Remove a webhook subscription |
| Profile | `get_profile` | Read your authenticated profile |

Filters in the table are optional. Single-record tools require a CPZ record UUID returned by a corresponding list tool. `get_order` takes the CPZ record ID, not the broker order ID. File reads return metadata; they do not download file contents or sample rows. Backtest tools read saved runs; they do not start a backtest.

### Pagination and data

All list tools take `limit` (integer 1–100) and `offset` (nonnegative integer, default 0), plus any sorting fields in their advertised schemas. The default limit is 50, except `list_accounts`, which defaults to 100. Use an explicit limit when paging. REST `count` is the current page length, not a total. Continue paging until fewer than `limit` items are returned before reporting a complete portfolio.

```json
{"limit":100,"offset":0}
```

For the next page of the same list, use `{"limit":100,"offset":100}`. An upstream error is not an empty final page.

`get_bars` accepts `symbols`, `timeframe`, `start`, `end`, `limit` (1–10,000 bars per symbol), and `feed` (`iex` or `sip`, subject to provider entitlements). Supported timeframes are `1Min`, `5Min`, `15Min`, `30Min`, `1Hour`, `2Hour`, `4Hour`, `1Day`, `1Week`, and `1Month`.

Middle-office lists support optional `entity_id` for an entity book where the caller is an active member; otherwise they use the personal book. Preserve minor-unit decimal strings as exact values rather than converting them to JavaScript numbers.

### Trading and side effects

Use `list_accounts` to inspect `environment` and `tradable` before selecting an account. `tradable: true` filters to routable accounts; false or omitted includes all. Account discovery covers more providers than order routing. Live or paper execution follows the chosen account and platform controls.

`place_order` requires positive quantities. Limit/stop-limit orders require `price`; stop/stop-limit orders require `stop_price`. Only `time_in_force: "day"` is exposed, because legacy routes support that duration only. Supported order types remain broker-dependent. `execute_strategy` can place trades and is not a signal preview or dry run. Invoke these tools only for trading the user has authorized.

Tool annotations describe side effects. Actual authorization is enforced by the REST API's key, subscription, ownership, and resource-scope checks. Legacy `read`/`write`/`trade` permissions are expanded by that API into resource scopes.

### Results and errors

Tool responses preserve readable JSON text and include structured content. Most read tools declare an `outputSchema` so a client can validate what came back: list routes return `{data, count}`, single-record routes return `{data}`, and a delete returns `{message}`. The action tools that proxy to another service (`execute_strategy`, `sync_portfolio`, `compute_risk`, `get_market_data`, `get_bars`) and the two writes with their own handlers (`place_order`, `create_connection`) declare no output schema, because their shape is not this server's to promise. Output validation is skipped for error results. Check `isError` before using the result. Malformed upstream responses and provider failures stay errors. Request IDs support tracing without logging credentials.

Eligible GET calls can retry transient upstream failures within a bounded timeout. Writes are not automatically retried. A timeout after order submission leaves the result unconfirmed; inspect existing orders and the broker before retrying. The public order route does not provide a general end-to-end idempotency guarantee.

## Resources and prompts

| Kind | Name | Purpose |
|---|---|---|
| Resource | `cpzai://guides/tool-usage` | Tool selection, pagination, and capability boundaries |
| Resource | `cpzai://guides/permissions` | Resource permissions and execution boundaries |
| Resource | `cpzai://guides/discovery` | Endpoints, deferred loading, and the search conventions |
| Prompt | `review_portfolio` | Portfolio review workflow; optional `account_id` |
| Prompt | `analyze_strategy` | Strategy investigation; required `strategy_id` |

Requesting a prompt returns instructions; it does not execute a workflow. Discover these using standard MCP methods. There is no `/mcp/info` endpoint.

## Progressive tool discovery

The full catalogue is 31 tools and roughly 27 KB of JSON Schema, which every client pays for on every request unless it can defer tool loading. Tool-selection accuracy also falls off once a model is choosing between more than about thirty tools. There are two endpoints, serving identical tools under different discovery models.

### `POST /mcp`: full catalogue

`tools/list` returns every tool. Use this when the client defers loading itself: it needs the definitions in order to defer them. With Claude's MCP connector, pair `defer_loading` with the tool search tool and keep the everyday reads loaded:

```json
{
  "type": "mcp_toolset",
  "mcp_server_name": "cpzai",
  "default_config": { "defer_loading": true },
  "configs": {
    "list_accounts":  { "defer_loading": false },
    "list_positions": { "defer_loading": false },
    "place_order":    { "defer_loading": false }
  }
}
```

Deferred definitions are still sent on every request; they stay out of the model's context until a search discovers them, and the prompt prefix is untouched, so the cache survives. Claude Code applies its own tool search to this endpoint with no configuration.

### `POST /mcp/compact`: server-side discovery

For clients with no deferral of their own. `tools/list` returns 15 tools instead of 31 (about 12 KB instead of 27 KB, a 55% cut):

- `search_tools`: natural-language or keyword query, optional `category`, returns each match with its **full input schema**. Searches tool names, titles, descriptions, parameter names, and parameter descriptions, so a field name such as `unsettled` or `entity_id` finds the tool that accepts it. Categories: strategies, backtests, orders, positions, accounts, market-data, risk, data, webhooks, middle-office, profile.
- `call_tool`: invokes a discovered tool by name with an arguments object matching its `input_schema`, and returns that tool's result unchanged.
- Every state-changing tool (`place_order`, `execute_strategy`, `create_strategy`, `update_strategy`, `create_connection`, `create_webhook`, `delete_webhook`, `sync_portfolio`, `compute_risk`) plus the read anchors `list_accounts`, `list_positions`, `list_orders`, `get_market_data`.

`call_tool` dispatches **read-only tools only**. A client gates approval on the tool name it can see, so routing an order through a generic dispatcher would hide it from the check meant to catch it. It also refuses a read-only tool that is already advertised, and answers an unknown name with near matches rather than a guess. Arguments are validated against the real tool schema before dispatch; a rejection returns the offending paths and that tool's schema.

### Protocol revisions

Both endpoints serve the **2026-07-28** revision and every legacy revision back to 2024-10-07 from the same URL.

- A 2026-07-28 client sends each request on its own, with no `initialize` handshake, names the method in the `Mcp-Method` header (and the tool in `Mcp-Name`) so a gateway can route without parsing the body, and carries its protocol version, client info and capabilities in `_meta`.
- `server/discover` returns capabilities, instructions and supported versions in one call.
- `tools/list`, `prompts/list`, `resources/list` and `server/discover` carry `ttlMs` and `cacheScope`. `tools/list` is always `private`: it is filtered per credential, so a shared cache would hand one key's catalogue to another.
- An `initialize`-based client negotiates 2025-11-25, 2025-06-18 or older exactly as before. Claude Code and the existing connectors are unaffected.

The server is stateless in both eras: no sessions, no `Mcp-Session-Id`, one fresh server per request.

### Scope-aware discovery

`tools/list` carries only the tools the calling credential's scopes permit. A `data` key sees 10 tools, not 31; an identity-only OAuth token sees `get_profile` alone; `search_tools` will not return an out-of-scope tool and `call_tool` will not dispatch one. Scopes come from `GET /me` on the REST API, cached per credential for 60 seconds and looked up only for `tools/list`, never on the call path.

If the lookup fails, or the REST API deployment predates the `scopes` field, the full catalogue is advertised and the reason is logged: unknown is not the same as none. Filtering is discovery, not enforcement. The REST API remains the only thing that decides what a credential may touch, so a tool that is present can still return 403.

Measured surfaces:

| Endpoint | Full scopes | `data` scope only |
|---|---|---|
| `/mcp` | 31 tools, ~31 KB | 10 tools, ~9 KB |
| `/mcp/compact` | 15 tools, ~13 KB | 6 tools, ~6 KB |

Tool names, arguments, results and pagination are identical on both endpoints. Discovery reads no account data and places no order.

## Architecture

```text
Remote MCP client
  → POST /mcp  (full catalogue) or POST /mcp/compact (search_tools + call_tool)
  → createMcpHandler, legacy: 'stateless' (2026-07-28 and every legacy revision)
  → fresh stateless server per request
  → user's API credentials, resolved from headers or encrypted OAuth token
  → CPZ REST API /functions/v1/rest-api/v1
  → existing user-scoped platform handlers
```

`src/tools.ts` and `src/expanded-tools.ts` own the public MCP schemas; `src/capabilities.ts` defines guide resources and workflow prompts; `src/tool-registry.ts` captures those same schemas as data and `src/tool-search.ts` turns them into the compact surface, so the advertised and dispatchable catalogues cannot drift apart. They are distinct from internal Simons tools and are not imported from a shared schema package. The server proxies to the existing REST adapter rather than querying user data with a service-role key. The hosted service also supports authenticated Simons chat proxy routes; those routes are not additional MCP tools.

## Local development

```bash
npm ci
export CPZ_API_BASE_URL=https://api.cpz-lab.com/functions/v1/rest-api
export MCP_BASE_URL=http://localhost:3001
export MCP_TOKEN_SECRET=replace-with-a-strong-development-secret
npm run dev
```

The client appends `/v1` to `CPZ_API_BASE_URL`. Its built-in default already includes `/functions/v1/rest-api`; setting the environment variable to the bare API domain is incorrect. No `CPZ_SERVICE_KEY` is required by this server.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3001) |
| `CPZ_API_BASE_URL` | REST adapter base before `/v1` |
| `CPZ_API_TIMEOUT_MS` | Upstream request timeout budget (default 20000 ms) |
| `MCP_BASE_URL` | Public origin used in OAuth discovery and redirects |
| `MCP_TOKEN_SECRET` | Shared secret for encrypted OAuth tokens and registrations |
| `ALLOW_LEGACY_BEARER` | Enables legacy plaintext bearer format only when `true` |
| `SIMONS_UPSTREAM_URL` | Optional Simons proxy upstream override |
| `SENTRY_DSN` | Optional error reporting |

OAuth registrations, codes, and tokens contain encrypted state. Production replicas must share `MCP_TOKEN_SECRET`. Without it, development uses a per-process random key and tokens cannot survive restarts or resolve on another replica. Refresh tokens have a 30-day lifetime; previous refresh tokens are not invalidated by rotation. Revoke the underlying CPZ API key to remove access.

### Verify and build

```bash
npm run export:catalog  # refresh tool-catalog.json after schema/description changes
npm test
npm run build
npm start
```

Tests cover registration, validation, routing, credentials, response errors, and OAuth behavior. No live order or strategy execution is required for local verification.

### Docker

```bash
docker build -t cpzai-mcp-server .
docker run --rm -p 3001:3001 \
  -e MCP_BASE_URL=http://localhost:3001 \
  -e MCP_TOKEN_SECRET=replace-with-a-strong-development-secret \
  cpzai-mcp-server
```

## Scope and contributing

The hosted endpoint is the supported user connection. This repository is provided for transparency and local development; production self-hosting is not currently supported. The hosted infrastructure is maintained separately.

CI compares `tool-catalog.json` with MCP discovery and checks every tool appears in this README. Export the same snapshot to the platform with `npm run export:catalog -- --output /path/to/cpzai/src/lib/mcp-tool-catalog.json`; its docs test checks the public tool table.

Keep the public schemas, behavioral tests, README, and CPZAI's [agent integration docs](https://ai.cpz-lab.com/docs/agent-integration/overview) in sync. Do not advertise internal Simons tools or planned SDK lookup, sandbox, patch, cancellation, or middle-office write capabilities until they have implemented and tested public routes.

[MIT](LICENSE) © CPZ Capital Ltd.

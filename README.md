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

Tool responses preserve readable JSON text and include structured content. Check `isError` before using the result. Malformed upstream responses and provider failures stay errors. Request IDs support tracing without logging credentials.

Eligible GET calls can retry transient upstream failures within a bounded timeout. Writes are not automatically retried. A timeout after order submission leaves the result unconfirmed; inspect existing orders and the broker before retrying. The public order route does not provide a general end-to-end idempotency guarantee.

## Resources and prompts

| Kind | Name | Purpose |
|---|---|---|
| Resource | `cpzai://guides/tool-usage` | Tool selection, pagination, and capability boundaries |
| Resource | `cpzai://guides/permissions` | Resource permissions and execution boundaries |
| Prompt | `review_portfolio` | Portfolio review workflow; optional `account_id` |
| Prompt | `analyze_strategy` | Strategy investigation; required `strategy_id` |

Requesting a prompt returns instructions; it does not execute a workflow. Discover these using standard MCP methods. There is no `/mcp/info` endpoint.

## Architecture

```text
Remote MCP client
  → POST /mcp (fresh stateless server per request)
  → user's API credentials, resolved from headers or encrypted OAuth token
  → CPZ REST API /functions/v1/rest-api/v1
  → existing user-scoped platform handlers
```

`src/tools.ts` and `src/expanded-tools.ts` own the public MCP schemas; `src/capabilities.ts` defines guide resources and workflow prompts. They are distinct from internal Simons tools and are not imported from a shared schema package. The server proxies to the existing REST adapter rather than querying user data with a service-role key. The hosted service also supports authenticated Simons chat proxy routes; those routes are not additional MCP tools.

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

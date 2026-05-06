<h1 align="center">CPZAI MCP Server</h1>

<p align="center">
  <strong>Model Context Protocol server for AI agent access to <a href="https://ai.cpz-lab.com">CPZAI</a></strong>
</p>

<p align="center">
  <a href="https://github.com/CPZ-Lab/cpzai-mcp-server"><img src="https://img.shields.io/badge/language-TypeScript-blue.svg" alt="TypeScript"></a>
  <a href="https://github.com/CPZ-Lab/cpzai-mcp-server/actions/workflows/ci.yml"><img src="https://github.com/CPZ-Lab/cpzai-mcp-server/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-v1.0-green.svg" alt="MCP v1.0"></a>
  <img src="https://img.shields.io/badge/transport-Streamable_HTTP-orange.svg" alt="Streamable HTTP">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

---

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that exposes [CPZAI](https://ai.cpz-lab.com) capabilities — strategy management, backtesting, multi-broker order routing (Alpaca / Interactive Brokers / FIX), portfolios, risk analytics, market data — as tools for any MCP-compatible AI agent (Claude, Cursor, GPT, etc.).

The hosted endpoint at `https://mcp.cpz-lab.com/mcp` is the only supported way to connect. This repo exists for transparency: anyone wiring their broker API keys through an AI agent should be able to read the exact code that handles those keys.

## Quick Start

You'll need a CPZ API key + secret. Create one at [ai.cpz-lab.com/settings/api-keys](https://ai.cpz-lab.com/settings/api-keys).

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cpzai": {
      "url": "https://mcp.cpz-lab.com/mcp",
      "headers": {
        "X-CPZ-Key": "your_cpz_key",
        "X-CPZ-Secret": "your_cpz_secret"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cpzai": {
      "url": "https://mcp.cpz-lab.com/mcp",
      "headers": {
        "X-CPZ-Key": "your_cpz_key",
        "X-CPZ-Secret": "your_cpz_secret"
      }
    }
  }
}
```

### Claude (web / mobile) via OAuth

The server speaks OAuth 2.1 + PKCE at `https://mcp.cpz-lab.com/.well-known/oauth-authorization-server`. Use Claude's "Connect a server" flow and point it at `https://mcp.cpz-lab.com/mcp`.

## Architecture

```
Agent (Cursor / Claude / GPT / custom)
        │
        │  Streamable HTTP + X-CPZ-Key / X-CPZ-Secret
        ▼
   mcp.cpz-lab.com
        │
        ▼
   Node.js MCP server (stateless)  ← this repo
        │
        │  per-request API key validation
        ▼
   CPZ Platform REST API
```

**Design decisions:**

- **Stateless transport.** Each `POST /mcp` creates a fresh server instance — no session tracking, scales horizontally without coordination.
- **Thin protocol adapter.** Validates the API key, then proxies tool calls to the CPZ REST API. Zero business logic in the MCP layer; what you see in `src/` is what runs in production.
- **Key auth.** Agents authenticate with CPZ platform API keys (`X-CPZ-Key` / `X-CPZ-Secret`) — the same keys used by the REST API and the [`cpz` Python SDK](https://pypi.org/project/cpz/).
- **Paper-only by default.** Live trading on a strategy requires explicit per-strategy promotion in the platform.

## Available tools

18 tools exposed today, organized by domain.

| Tool | Description | Read-only |
|------|-------------|:---------:|
| **Strategies** | | |
| `list_strategies` | List trading strategies with filtering | ✓ |
| `get_strategy` | Get a specific strategy by ID | ✓ |
| `create_strategy` | Create a new trading strategy | |
| `update_strategy` | Update an existing strategy | |
| **Backtests** | | |
| `get_backtest_results` | List backtest run results | ✓ |
| **Orders & trading** | | |
| `list_orders` | List trading orders with filtering | ✓ |
| `place_order` | Place a new trading order | |
| `list_positions` | List current portfolio positions | ✓ |
| `sync_portfolio` | Trigger portfolio sync across brokers | |
| `list_accounts` | List connected trading accounts | ✓ |
| **Market data** | | |
| `get_market_data` | Real-time quotes (price, bid/ask, volume) | ✓ |
| **Risk** | | |
| `compute_risk` | Compute fresh risk snapshot (VaR, Sharpe, drawdown) | |
| `list_risk_snapshots` | List historical risk snapshots | ✓ |
| **Execution** | | |
| `execute_strategy` | Execute a strategy on the Python backend | |
| **Webhooks** | | |
| `list_webhooks` | List webhook subscriptions | ✓ |
| `create_webhook` | Subscribe to platform events | |
| `delete_webhook` | Remove a webhook subscription | |
| **User** | | |
| `get_profile` | Get authenticated user profile | ✓ |

## Local development

```bash
npm install

export CPZ_API_BASE_URL=https://api.cpz-lab.com
export CPZ_SERVICE_KEY=your_service_key

npm run dev
# server starts on http://localhost:3001
```

### Tests + type check

```bash
npm test            # single run
npm run test:watch  # watch mode
npx tsc --noEmit    # type check
```

### Build

```bash
npm run build       # compiles TS → dist/
npm start           # runs the compiled server
```

### Docker

```bash
docker build -t cpzai-mcp-server .
docker run --rm -p 3001:3001 \
  -e CPZ_API_BASE_URL=https://api.cpz-lab.com \
  -e CPZ_SERVICE_KEY=your_service_key \
  cpzai-mcp-server
```

## Security model

- All connections HTTPS with TLS 1.3 at the edge.
- API credentials are forwarded in HTTP headers and **never logged**.
- Per-request API key validation against the platform's `api_keys` table.
- All data access is user-scoped via the `user_id` derived from the validated key.
- OAuth tokens (when used) are held in server memory only — never persisted.

See the [privacy policy](https://mcp.cpz-lab.com/privacy) for the full data-handling story.

## Self-hosting

We don't currently support self-hosting. Use the hosted endpoint at `https://mcp.cpz-lab.com/mcp` with your CPZ API key. The hosted server is the same code in this repo plus AWS infrastructure (ALB, ECS Fargate, WAF, secrets) that's not part of this repo.

If you have a strong reason to self-host (e.g. air-gapped trading desk), open an issue and we'll talk.

## Contributing

Issues and PRs welcome. Before submitting:

- `npx tsc --noEmit` must pass
- `npm test` must pass
- Keep changes minimal and aligned with existing patterns

## License

[MIT](LICENSE) © CPZ Capital Ltd.

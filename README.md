<p align="center">
  <a href="https://ai.cpz-lab.com/">
    <img src="https://drive.google.com/uc?id=1JY-PoPj9GHmpq3bZLC7WyJLbGuT1L3hN" alt="CPZAI" width="180">
  </a>
</p>

<h1 align="center">Aquila MCP Server</h1>

<p align="center">
  <strong>Model Context Protocol Server for AI Agent Access to Aquila Quant Studio</strong>
</p>

<p align="center">
  <a href="https://github.com/CPZ-Lab/aquila-mcp-server"><img src="https://img.shields.io/badge/language-TypeScript-blue.svg" alt="TypeScript"></a>
  <a href="https://github.com/CPZ-Lab/aquila-mcp-server/actions/workflows/ci.yml"><img src="https://github.com/CPZ-Lab/aquila-mcp-server/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://img.shields.io/badge/MCP-v1.0-green"><img src="https://img.shields.io/badge/MCP-v1.0-green.svg" alt="MCP v1.0"></a>
  <a href="https://img.shields.io/badge/transport-Streamable_HTTP-orange"><img src="https://img.shields.io/badge/transport-Streamable_HTTP-orange.svg" alt="Streamable HTTP"></a>
  <a href="https://github.com/CPZ-Lab/aquila-mcp-server"><img src="https://img.shields.io/badge/license-private-lightgrey.svg" alt="License"></a>
</p>

---

Production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that exposes [Aquila Quant Studio](https://github.com/CPZ-Lab/aquila-quant-studio) capabilities as tools for AI agents (Claude, Cursor, GPT, and any MCP-compatible client).

Deployed on AWS ECS Fargate at `mcp.cpz-lab.com` and managed by [CPZ Quant Studio](https://github.com/CPZ-Lab/aquila-quant-studio).

## Architecture

```
Agent (Cursor / Claude / GPT / custom)
        │
        │  Streamable HTTP + CPZ API key
        ▼
   ALB + AWS WAF  ──  mcp.cpz-lab.com:443
        │
        ▼
   ECS Fargate  ──  Node.js MCP server (stateless)
        │
        │  Service role / API key validation
        ▼
   CPZ Platform API  ──  REST API + Postgres
```

**Key design decisions:**

- **Stateless transport** — each request creates a fresh server instance. No session tracking. Scales horizontally without coordination.
- **Thin protocol adapter** — validates API keys against the platform database, then proxies tool calls to the REST API. Zero business logic in the MCP layer.
- **API key auth** — agents authenticate with CPZ platform API keys (`X-CPZ-Key` / `X-CPZ-Secret`), the same keys used by the REST API and [`cpz` Python SDK](https://github.com/CPZ-Lab/cpz-py).

## Available Tools

18 tools organized by domain:

| Tool | Description | Read-only |
|------|-------------|:---------:|
| **Strategies** | | |
| `list_strategies` | List trading strategies with filtering | Yes |
| `get_strategy` | Get a specific strategy by ID | Yes |
| `create_strategy` | Create a new trading strategy | |
| `update_strategy` | Update an existing strategy | |
| **Backtests** | | |
| `get_backtest_results` | List backtest run results | Yes |
| **Orders & Trading** | | |
| `list_orders` | List trading orders with filtering | Yes |
| `place_order` | Place a new trading order | |
| `list_positions` | List current portfolio positions | Yes |
| `sync_portfolio` | Trigger portfolio sync across brokers | |
| `list_accounts` | List connected trading accounts | Yes |
| **Market Data** | | |
| `get_market_data` | Fetch real-time quotes (price, bid/ask, volume) | Yes |
| **Risk** | | |
| `compute_risk` | Compute fresh risk snapshot (VaR, Sharpe, drawdown) | |
| `list_risk_snapshots` | List historical risk snapshots | Yes |
| **Execution** | | |
| `execute_strategy` | Execute a strategy on the Python backend | |
| **Webhooks** | | |
| `list_webhooks` | List webhook subscriptions | Yes |
| `create_webhook` | Subscribe to platform events | |
| `delete_webhook` | Remove a webhook subscription | |
| **User** | | |
| `get_profile` | Get authenticated user profile | Yes |

## Quick Start

### Connect from Cursor

Add to your Cursor MCP config (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "aquila": {
      "url": "https://mcp.cpz-lab.com/mcp",
      "headers": {
        "X-CPZ-Key": "your_cpz_key_prefix",
        "X-CPZ-Secret": "your_cpz_secret"
      }
    }
  }
}
```

### Connect from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aquila": {
      "url": "https://mcp.cpz-lab.com/mcp",
      "headers": {
        "X-CPZ-Key": "your_cpz_key_prefix",
        "X-CPZ-Secret": "your_cpz_secret"
      }
    }
  }
}
```

## Local Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
npm install
```

### Run locally

```bash
export CPZ_API_BASE_URL=https://api.cpz-lab.com
export CPZ_SERVICE_KEY=your_service_key

npm run dev
# Server starts on http://localhost:3001
```

### Run tests

```bash
npm test            # single run
npm run test:watch  # watch mode
```

### Type check

```bash
npx tsc --noEmit
```

## CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push and PR to `main`:

| Job | Steps |
|-----|-------|
| **test** | Install → Type check → Run tests → Lint |
| **docker** | Build Docker image (validates Dockerfile) |
| **deploy** | *(main only)* Push to ECR → Force ECS deployment |

The deploy job uses OIDC authentication with AWS (`AWS_DEPLOY_ROLE_ARN` secret). No long-lived AWS credentials stored in GitHub.

## Production Infrastructure

All infrastructure is managed with Terraform in [`infra/main.tf`](infra/main.tf).

### AWS Resources

| Resource | Name | Purpose |
|----------|------|---------|
| VPC | `aquila-mcp-vpc` | Isolated network (`10.0.0.0/16`) |
| Subnets | `public-a`, `public-b` | Multi-AZ in `us-east-1` |
| ECR | `aquila-mcp-server` | Container image registry |
| ECS Cluster | `aquila-mcp` | Fargate cluster with Container Insights |
| ECS Service | `aquila-mcp` | 1 task, auto-scales 1–4 (0.5 vCPU / 1 GB) |
| ALB | `aquila-mcp` | Internet-facing load balancer |
| ACM | `mcp.cpz-lab.com` | TLS 1.3 certificate (DNS-validated) |
| WAF | `aquila-mcp-waf` | Rate limiting (100/min) + AWS Managed Rules |
| Secrets Manager | `aquila/mcp-server/config` | Platform API URL + service key |
| CloudWatch | `/ecs/aquila-mcp` | Logs (30-day retention) + 5xx alarm |
| Auto Scaling | CPU target tracking | Scale at 60% CPU utilization |
| CodeBuild | `aquila-mcp-build` | Remote Docker builds (no local Docker) |

### Network Diagram

```
Internet
    │
    ▼
┌──────────────────────────────────────┐
│  ALB (public subnets, multi-AZ)      │
│  mcp.cpz-lab.com:443 (TLS 1.3)      │
│  + AWS WAF (rate limit + managed)    │
└──────────┬───────────────────────────┘
           │ :3001
           ▼
┌──────────────────────────────────────┐
│  ECS Fargate (public subnets)        │
│  aquila-mcp-server:latest            │
│  SG: inbound 3001 from ALB only     │
│  Secrets: AWS Secrets Manager        │
└──────────┬───────────────────────────┘
           │ HTTPS
           ▼
┌──────────────────────────────────────┐
│  CPZ Platform API                    │
│  api.cpz-lab.com                     │
│  ├── REST API                        │
│  ├── API key authentication          │
│  └── Platform data layer             │
└──────────────────────────────────────┘
```

### Deploy from Scratch

<details>
<summary><strong>Full deployment walkthrough</strong></summary>

#### 1. Prerequisites

```bash
aws sts get-caller-identity  # AWS CLI configured
terraform --version           # >= 1.5
gh auth status                # GitHub CLI authenticated
```

#### 2. Create infrastructure

```bash
cd infra
terraform init
terraform plan
terraform apply
```

Outputs: `ecr_repository_url`, `alb_dns_name`, `acm_validation_records`, `mcp_endpoint`

#### 3. DNS Setup

Add two CNAME records in your DNS provider:

1. **SSL validation** — from `acm_validation_records` output
2. **`mcp` → ALB** — from `alb_dns_name` output

Wait 5–30 minutes for ACM certificate validation.

#### 4. Store secrets

```bash
aws secretsmanager put-secret-value \
  --secret-id "aquila/mcp-server/config" \
  --secret-string '{"CPZ_API_BASE_URL":"https://api.cpz-lab.com","CPZ_SERVICE_KEY":"<key>"}'
```

#### 5. Build and push image

Via AWS CodeBuild (no local Docker):

```bash
zip -r /tmp/mcp-server-source.zip . -x "node_modules/*" -x "dist/*" -x "infra/.terraform/*"
aws s3 cp /tmp/mcp-server-source.zip s3://aquila-mcp-build-710414548933/source.zip
aws codebuild start-build --project-name aquila-mcp-build
```

#### 6. Force deployment

```bash
aws ecs update-service --cluster aquila-mcp --service aquila-mcp --force-new-deployment
```

#### 7. Verify

```bash
curl https://mcp.cpz-lab.com/health
```

</details>

### Updating

After code changes, push to `main` and CI/CD handles the rest. For manual deploys:

```bash
zip -r /tmp/mcp-server-source.zip . -x "node_modules/*" -x "dist/*" -x "infra/.terraform/*"
aws s3 cp /tmp/mcp-server-source.zip s3://aquila-mcp-build-710414548933/source.zip
aws codebuild start-build --project-name aquila-mcp-build
# Wait for build, then:
aws ecs update-service --cluster aquila-mcp --service aquila-mcp --force-new-deployment
```

### Monitoring

```bash
# Service status
aws ecs describe-services --cluster aquila-mcp --services aquila-mcp \
  --query "services[0].{running:runningCount,desired:desiredCount}"

# Live logs
aws logs tail /ecs/aquila-mcp --since 1h --follow

# Alarms
aws cloudwatch describe-alarms --alarm-name-prefix aquila-mcp
```

### Estimated Cost

| Resource | Monthly |
|----------|---------|
| ECS Fargate (0.5 vCPU, 1 GB, 1 task) | ~$15 |
| ALB | ~$16 |
| WAF | ~$6 |
| Secrets Manager | ~$0.40 |
| CloudWatch Logs | ~$0.50/GB |
| ECR | ~$0.10/GB |
| **Total (idle)** | **~$38** |

## Security

- All traffic HTTPS with TLS 1.3
- AWS WAF rate-limits 100 requests/minute per IP
- AWS Managed Rules block common web exploits (SQLi, XSS, etc.)
- ECS container runs as non-root user
- Platform credentials in AWS Secrets Manager (never in code)
- API key validation per-request against `api_keys` table
- All data access user-scoped via `user_id` from validated API key
- Deployment circuit breaker with automatic rollback

## Related Repositories

| Repo | Description |
|------|-------------|
| [aquila-quant-studio](https://github.com/CPZ-Lab/aquila-quant-studio) | Main platform (React frontend) |
| [cpz-py](https://github.com/CPZ-Lab/cpz-py) | Python SDK for the CPZ API |
| [cpz-risk-server](https://github.com/CPZ-Lab/cpz-risk-server) | Risk analytics compute server |
| [aquila-hft-engine](https://github.com/CPZ-Lab/aquila-hft-engine) | Low-latency Rust trading engine |
| [aquila-backend](https://github.com/CPZ-Lab/aquila-backend) | Python strategy execution backend |

## License

Private — [CPZ Lab](https://www.cpz-lab.com/)

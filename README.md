# Aquila Quant Studio — MCP Server

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that exposes Aquila Quant Studio capabilities as tools for AI agents (Claude, Cursor, GPT, etc.).

## Architecture

```
Agent (Cursor / Claude / GPT / custom)
        │
        │  Streamable HTTP + CPZ API key
        ▼
   ALB + AWS WAF  ──  mcp.cpz-lab.com
        │
        ▼
   ECS Fargate  ──  Node.js MCP server (stateless)
        │
        │  Service role / API key validation
        ▼
   Supabase  ──  REST API edge functions + Postgres
```

### Key design decisions

- **Stateless transport** — each MCP request creates a fresh server instance. No session tracking, no in-memory state. Scales horizontally without coordination.
- **Thin protocol adapter** — the MCP server validates API keys against Supabase, then proxies tool calls to the `rest-api` edge function. Zero business logic in the MCP layer.
- **API key auth** — agents authenticate with CPZ platform API keys (`X-CPZ-Key` / `X-CPZ-Secret` headers), the same keys used by the REST API and Python SDK.

## Available Tools (18)

| Tool | Description | Destructive |
|------|-------------|:-----------:|
| `list_strategies` | List trading strategies with filtering | |
| `get_strategy` | Get a specific strategy by ID | |
| `create_strategy` | Create a new trading strategy | |
| `update_strategy` | Update an existing strategy | |
| `get_backtest_results` | List backtest run results | |
| `list_orders` | List trading orders | |
| `place_order` | Place a new trading order | Yes |
| `list_positions` | List current portfolio positions | |
| `sync_portfolio` | Trigger portfolio sync across brokers | |
| `list_accounts` | List connected trading accounts | |
| `get_market_data` | Fetch real-time market data | |
| `compute_risk` | Compute fresh risk snapshot | |
| `list_risk_snapshots` | List historical risk snapshots | |
| `execute_strategy` | Execute a strategy on Python backend | Yes |
| `list_webhooks` | List webhook subscriptions | |
| `create_webhook` | Subscribe to platform events | |
| `delete_webhook` | Remove a webhook subscription | Yes |
| `get_profile` | Get authenticated user profile | |

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
# Set environment variables
export SUPABASE_URL=https://brkcjojfmlygsujiqglv.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Start dev server
npm run dev
```

The server starts on `http://localhost:3001`. Test the health endpoint:

```bash
curl http://localhost:3001/health
```

### Connect from Cursor / Claude Desktop

Add to your MCP client config:

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

## Production Infrastructure

All infrastructure is managed with Terraform in `infra/main.tf`.

### AWS Resources Created

| Resource | Purpose |
|----------|---------|
| **VPC** | Isolated network (`10.0.0.0/16`) with public subnets in `us-east-1a` and `us-east-1b` |
| **ECR Repository** | `aquila-mcp-server` — container image registry |
| **ECS Cluster** | `aquila-mcp` — Fargate cluster with Container Insights |
| **ECS Service** | 1 task (auto-scales 1–4), 0.5 vCPU / 1 GB RAM, deployment circuit breaker |
| **ALB** | `aquila-mcp` — internet-facing Application Load Balancer |
| **HTTPS Listener** | TLS 1.3, ACM certificate for `mcp.cpz-lab.com` |
| **HTTP Listener** | Redirects to HTTPS (301) |
| **AWS WAF** | Rate limiting (100 req/min per IP), AWS Managed Rules (common threats) |
| **ACM Certificate** | DNS-validated SSL for `mcp.cpz-lab.com` |
| **Secrets Manager** | `aquila/mcp-server/supabase` — stores `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` |
| **CloudWatch Logs** | `/ecs/aquila-mcp` — 30-day retention |
| **CloudWatch Alarm** | Alerts on >10 5xx errors in 5 minutes |
| **Auto Scaling** | Target tracking on CPU utilization (target: 60%) |
| **CodeBuild Project** | `aquila-mcp-build` — builds Docker image from S3 source, pushes to ECR |
| **S3 Bucket** | `aquila-mcp-build-710414548933` — stores build source zip |

### Network Diagram

```
Internet
    │
    ▼
┌──────────────────────────────────────┐
│  ALB (public subnets)                │
│  mcp.cpz-lab.com:443                 │
│  + AWS WAF (rate limit + managed)    │
└──────────┬───────────────────────────┘
           │ :3001
           ▼
┌──────────────────────────────────────┐
│  ECS Fargate Tasks (public subnets)  │
│  aquila-mcp-server:latest            │
│  SG: inbound 3001 from ALB only     │
│  Secrets: from AWS Secrets Manager   │
└──────────┬───────────────────────────┘
           │ HTTPS
           ▼
┌──────────────────────────────────────┐
│  Supabase                            │
│  brkcjojfmlygsujiqglv.supabase.co    │
│  - rest-api edge function            │
│  - api_keys table (auth)             │
│  - All platform data                 │
└──────────────────────────────────────┘
```

### Deploy from scratch

#### 1. Prerequisites

- AWS CLI configured (`aws sts get-caller-identity`)
- Terraform >= 1.5 (`brew install terraform`)
- GitHub CLI (`brew install gh`)

#### 2. Create infrastructure

```bash
cd infra

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Deploy everything
terraform apply
```

Terraform will output:
- `ecr_repository_url` — where to push Docker images
- `alb_dns_name` — CNAME target for DNS
- `acm_validation_records` — DNS records for SSL certificate validation
- `mcp_endpoint` — the final MCP URL

#### 3. DNS Setup (Squarespace)

Add two CNAME records in your DNS provider:

1. **SSL Certificate validation** (from `acm_validation_records` output)
2. **`mcp` → ALB DNS name** (from `alb_dns_name` output)

Wait for the ACM certificate to validate (5–30 minutes after DNS propagation).

#### 4. Store secrets

```bash
aws secretsmanager put-secret-value \
  --secret-id "aquila/mcp-server/supabase" \
  --secret-string '{"SUPABASE_URL":"https://brkcjojfmlygsujiqglv.supabase.co","SUPABASE_SERVICE_ROLE_KEY":"your_service_role_key_here"}'
```

#### 5. Build and push Docker image

Using AWS CodeBuild (no local Docker required):

```bash
# Zip the source
zip -r /tmp/mcp-server-source.zip . -x "node_modules/*" -x "dist/*" -x "infra/.terraform/*"

# Upload to S3
aws s3 cp /tmp/mcp-server-source.zip s3://aquila-mcp-build-710414548933/source.zip

# Trigger build
aws codebuild start-build --project-name aquila-mcp-build
```

Or with local Docker:

```bash
# Login to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin 710414548933.dkr.ecr.us-east-1.amazonaws.com

# Build and push
docker build -t 710414548933.dkr.ecr.us-east-1.amazonaws.com/aquila-mcp-server:latest .
docker push 710414548933.dkr.ecr.us-east-1.amazonaws.com/aquila-mcp-server:latest
```

#### 6. Force new deployment (after image push or secret update)

```bash
aws ecs update-service --cluster aquila-mcp --service aquila-mcp --force-new-deployment
```

#### 7. Verify

```bash
curl https://mcp.cpz-lab.com/health
# {"status":"ok","service":"aquila-mcp-server","timestamp":"..."}
```

### Updating the server

After code changes:

```bash
# Re-zip, upload, build
cd /path/to/mcp-server
zip -r /tmp/mcp-server-source.zip . -x "node_modules/*" -x "dist/*" -x "infra/.terraform/*"
aws s3 cp /tmp/mcp-server-source.zip s3://aquila-mcp-build-710414548933/source.zip
aws codebuild start-build --project-name aquila-mcp-build

# Wait for build to succeed, then force new deployment
aws ecs update-service --cluster aquila-mcp --service aquila-mcp --force-new-deployment
```

### Monitoring

```bash
# ECS service status
aws ecs describe-services --cluster aquila-mcp --services aquila-mcp \
  --query "services[0].{running:runningCount,pending:pendingCount,desired:desiredCount}"

# Recent logs
aws logs tail /ecs/aquila-mcp --since 1h

# CloudWatch alarms
aws cloudwatch describe-alarms --alarm-name-prefix aquila-mcp
```

### Estimated monthly cost

| Resource | Cost |
|----------|------|
| ECS Fargate (0.5 vCPU, 1 GB, 1 task) | ~$15 |
| ALB | ~$16 + $0.008/LCU-hr |
| WAF | ~$6 + $0.60/M requests |
| NAT Gateway | $0 (using public subnets) |
| Secrets Manager | ~$0.40 |
| CloudWatch Logs | ~$0.50/GB |
| ECR | ~$0.10/GB |
| **Total (idle)** | **~$38/month** |

## Security

- All traffic is HTTPS with TLS 1.3
- AWS WAF rate-limits to 100 requests/minute per IP
- AWS Managed Rules block common web exploits
- ECS tasks run as non-root user in the container
- Supabase credentials stored in AWS Secrets Manager (never in code or env vars)
- API key validation happens per-request against the Supabase `api_keys` table
- All data access is user-scoped via `user_id` from the validated API key

## License

Private — Aquila Quant Studio / CPZ Lab

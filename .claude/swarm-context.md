# Swarm context: aquila-mcp-server

## Stack
- MCP server exposing the CPZ platform to AI clients, deployed at mcp.cpz-lab.com.

## Hard invariants
- Known trap: `CPZ_API_BASE_URL` misconfiguration silently points tools at the wrong environment; verify env resolution when touching request paths.
- Tools can place trades and read portfolios; auth and confirmation gates are money-safety features, never weaken or bypass them.
- No fallbacks, no mock data; a tool that fabricates a response on upstream failure is a critical defect.

## Verification
- Run the test suite; exercise tools against the paper environment only.

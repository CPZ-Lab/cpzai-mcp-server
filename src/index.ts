import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'aquila-mcp-server', timestamp: new Date().toISOString() });
});

app.post('/mcp', async (req, res) => {
  const server = new McpServer({
    name: 'aquila-quant-studio',
    version: '1.0.0',
  });

  registerTools(server, req);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Use POST for Streamable HTTP.' }));
});

app.delete('/mcp', async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Sessions are stateless.' }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aquila MCP server listening on port ${PORT}`);
});

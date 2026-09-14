import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request } from 'express';
import { registerTools } from './tools.js';
import { registerCapabilities, SERVER_INSTRUCTIONS } from './capabilities.js';

export function createMcpServer(req: Request) {
  const server = new McpServer({ name: 'cpzai-mcp-server', version: '1.2.0' }, {
    instructions: SERVER_INSTRUCTIONS,
  });
  registerTools(server, req);
  registerCapabilities(server);
  return server;
}

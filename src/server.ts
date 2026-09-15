import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request } from 'express';
import { registerTools } from './tools.js';
import { registerCapabilities, serverInstructions } from './capabilities.js';
import { advertise, captureTools } from './tool-registry.js';
import { advertisedTools, registerToolSearch } from './tool-search.js';

/**
 * `full` advertises every tool, which is what a client with its own deferred
 * loading (Claude's tool search, the MCP connector's `defer_loading`) wants:
 * it needs the definitions in order to defer them. `compact` advertises the
 * state-changing tools plus a few read anchors and hands the rest to
 * `search_tools`/`call_tool`, for clients with no deferral of their own.
 */
export type ToolMode = 'full' | 'compact';

export function createMcpServer(req: Request, mode: ToolMode = 'full') {
  const server = new McpServer({ name: 'cpzai-mcp-server', version: '1.3.0' }, {
    instructions: serverInstructions(mode),
  });

  // One definition of every tool. Capture first, then decide what reaches
  // tools/list, so the advertised surface and the dispatchable surface can
  // never drift apart.
  const captured = captureTools(server => registerTools(server, req));
  if (mode === 'compact') registerToolSearch(server, captured);
  advertise(server, advertisedTools(captured, mode));

  registerCapabilities(server);
  return server;
}

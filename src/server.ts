import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request } from 'express';
import { registerTools } from './tools.js';
import { registerCapabilities, serverInstructions } from './capabilities.js';
import { advertise, captureTools } from './tool-registry.js';
import { advertisedTools, registerToolSearch } from './tool-search.js';
import { isAllowed } from './scopes.js';

/**
 * `full` advertises every tool, which is what a client with its own deferred
 * loading (Claude's tool search, the MCP connector's `defer_loading`) wants:
 * it needs the definitions in order to defer them. `compact` advertises the
 * state-changing tools plus a few read anchors and hands the rest to
 * `search_tools`/`call_tool`, for clients with no deferral of their own.
 */
export type ToolMode = 'full' | 'compact';

export interface ServerOptions {
  mode?: ToolMode;
  /**
   * Scopes held by the calling credential, or null/undefined when they could
   * not be determined. Null means unknown, never empty: the full catalogue is
   * advertised in that case, as this server has always done. Enforcement lives
   * in the REST API either way.
   */
  scopes?: Set<string> | null;
}

export function createMcpServer(req: Request, options: ToolMode | ServerOptions = {}) {
  const { mode = 'full', scopes = null } = typeof options === 'string' ? { mode: options } as ServerOptions : options;

  const server = new McpServer({ name: 'cpzai-mcp-server', version: '1.3.0' }, {
    instructions: serverInstructions(mode),
  });

  // One definition of every tool. Capture first, then decide what reaches
  // tools/list, so the advertised surface and the dispatchable surface can
  // never drift apart.
  const captured = captureTools(server => registerTools(server, req));
  // Scope filtering happens before the mode split so that search_tools never
  // offers, and call_tool never dispatches, a tool this key cannot call.
  const permitted = scopes ? captured.filter(tool => isAllowed(tool.name, scopes)) : captured;

  if (mode === 'compact') registerToolSearch(server, permitted);
  advertise(server, advertisedTools(permitted, mode));

  registerCapabilities(server);
  return server;
}

/** Export documentation metadata from the tools advertised over MCP itself. */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/server.js';

export interface ToolCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
}

export async function readToolCatalog(): Promise<ToolCatalogEntry[]> {
  // Discovery needs no credentials and never invokes a tool or the REST API.
  const server = createMcpServer({ headers: {} } as Request);
  const client = new Client({ name: 'cpzai-docs-catalog', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog: ToolCatalogEntry[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        catalog.push({
          name: tool.name,
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        });
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor) || seenCursors.size >= 100) throw new Error('Tool discovery pagination did not terminate.');
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return catalog.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  } finally {
    await client.close();
    await server.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
    throw new Error('Usage: tsx scripts/export-tool-catalog.ts [--output path]');
  }
  const destination = args.length === 0
    ? fileURLToPath(new URL('../tool-catalog.json', import.meta.url))
    : resolve(args[1]);
  const catalog = await readToolCatalog();
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(`Exported ${catalog.length} MCP tools to ${destination}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The imported OAuth module owns a long-lived sweep timer. This one-shot
  // exporter exits only after discovery, transport cleanup, and the write finish.
  main().then(() => process.exit(0)).catch(error => {
    console.error('Tool catalog export failed:', error);
    process.exit(1);
  });
}

import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToolCatalog } from '../scripts/export-tool-catalog.js';

afterEach(() => vi.unstubAllGlobals());

describe('published tool catalog', () => {
  it('matches the actual MCP tools/list response without making API requests', async () => {
    const fetchMock = vi.fn(() => { throw new Error('Catalog discovery must not make upstream HTTP requests'); });
    vi.stubGlobal('fetch', fetchMock);
    const published = JSON.parse(await readFile(new URL('../tool-catalog.json', import.meta.url), 'utf8'));
    const advertised = await readToolCatalog();
    expect(published).toEqual(advertised);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new Set(advertised.map(tool => tool.name)).size).toBe(advertised.length);
  });

  it('documents every advertised tool by its exact name in the README', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const advertised = await readToolCatalog();
    const undocumented = advertised.filter(tool => !readme.includes(`\`${tool.name}\``)).map(tool => tool.name);
    expect(undocumented).toEqual([]);
  });
});

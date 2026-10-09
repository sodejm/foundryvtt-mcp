/**
 * @fileoverview Unit tests for world handlers — search, summary, refresh
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { FoundryWorld } from '../../../foundry/types.js';
import { handleGetWorldSummary, handleRefreshWorldData, handleSearchWorld } from '../world.js';
import { paginationMetadata } from './pagination-fixture.js';

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('handleSearchWorld', () => {
  it('returns one unified page across all world document types', async () => {
    const records = [
      { id: 'Actor00000000001', name: 'Wizard', documentType: 'Actor', type: 'character' },
      { id: 'Item000000000001', name: 'Wand', documentType: 'Item', type: 'weapon' },
      { id: 'Scene00000000001', name: 'Tower', documentType: 'Scene', active: true },
      { id: 'Journal000000001', name: 'Lore', documentType: 'JournalEntry', pageCount: 0 },
    ];
    const searchWorldPage = vi.fn().mockResolvedValue({ records, ...paginationMetadata(4) });
    const result = await handleSearchWorld({ query: 'w' }, {
      searchWorldPage,
    } as unknown as FoundryClient);
    expect(searchWorldPage).toHaveBeenCalledWith({ query: 'w' });
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 2,
      scope: 'world',
      records,
      returnedCount: 4,
    });
    for (const record of records) {
      expect(getText(result)).toContain(record.id);
    }
  });
  it('forwards a single limit and cursor for the entire result set', async () => {
    const searchWorldPage = vi
      .fn()
      .mockResolvedValue({ records: [], ...paginationMetadata(0, 25, 2) });
    const result = await handleSearchWorld({ limit: 2, cursor: 'next' }, {
      searchWorldPage,
    } as unknown as FoundryClient);
    expect(searchWorldPage).toHaveBeenCalledWith({ limit: 2, cursor: 'next' });
    expect(result.structuredContent).toMatchObject({ total: 25, limit: 2, complete: false });
  });
  it('returns completion metadata for an empty world', async () => {
    const result = await handleSearchWorld({}, {
      searchWorldPage: vi.fn().mockResolvedValue({ records: [], ...paginationMetadata(0) }),
    } as unknown as FoundryClient);
    expect(getText(result)).toContain('No results found.');
    expect(result.structuredContent).toMatchObject({ total: 0, complete: true, nextCursor: null });
  });
  it('wraps backend errors in McpError', async () => {
    await expect(
      handleSearchWorld({}, {
        searchWorldPage: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as FoundryClient),
    ).rejects.toThrow(McpError);
  });
});

describe('handleGetWorldSummary', () => {
  it('returns formatted world info and counts on happy path', async () => {
    const worldInfo: FoundryWorld = {
      id: 'world-1',
      title: 'My Campaign',
      description: '',
      system: 'dnd5e',
      coreVersion: '13.348',
      systemVersion: '4.0.0',
      playtime: 0,
      created: '',
      modified: '',
    };
    const client = {
      getWorldInfo: vi.fn().mockResolvedValue(worldInfo),
      getWorldSummary: vi.fn().mockReturnValue({ actors: 12, items: 50 }),
    } as unknown as FoundryClient;

    const result = await handleGetWorldSummary({}, client);
    const text = getText(result);

    expect(text).toContain('**World: My Campaign**');
    expect(text).toContain('**System:** dnd5e (4.0.0)');
    expect(text).toContain('**Core Version:** 13.348');
    expect(text).toContain('- **actors**: 12');
    expect(text).toContain('- **items**: 50');
  });

  it('shows fallback when summary returns no entries', async () => {
    const worldInfo: FoundryWorld = {
      id: 'world-1',
      title: 'Empty',
      description: '',
      system: 'dnd5e',
      coreVersion: '13.0',
      systemVersion: '4.0',
      playtime: 0,
      created: '',
      modified: '',
    };
    const client = {
      getWorldInfo: vi.fn().mockResolvedValue(worldInfo),
      getWorldSummary: vi.fn().mockReturnValue({}),
    } as unknown as FoundryClient;

    const result = await handleGetWorldSummary({}, client);
    const text = getText(result);

    expect(text).toContain('No data available — not connected.');
  });

  it('wraps getWorldInfo errors in McpError', async () => {
    const client = {
      getWorldInfo: vi.fn().mockRejectedValue(new Error('offline')),
      getWorldSummary: vi.fn().mockReturnValue({}),
    } as unknown as FoundryClient;

    await expect(handleGetWorldSummary({}, client)).rejects.toThrow(McpError);
  });
});

describe('handleRefreshWorldData', () => {
  it('calls refresh and reports the new collection counts', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const client = {
      refreshWorldData: refresh,
      getWorldSummary: vi.fn().mockReturnValue({ actors: 3, items: 7 }),
    } as unknown as FoundryClient;

    const result = await handleRefreshWorldData({}, client);
    const text = getText(result);

    expect(refresh).toHaveBeenCalled();
    expect(text).toContain('World data refreshed successfully.');
    expect(text).toContain('- **actors**: 3');
    expect(text).toContain('- **items**: 7');
  });

  it('wraps refresh errors in McpError', async () => {
    const client = {
      refreshWorldData: vi.fn().mockRejectedValue(new Error('socket lost')),
      getWorldSummary: vi.fn().mockReturnValue({}),
    } as unknown as FoundryClient;

    await expect(handleRefreshWorldData({}, client)).rejects.toThrow(McpError);
  });

  it('produces a result even when getWorldSummary returns no entries', async () => {
    const client = {
      refreshWorldData: vi.fn().mockResolvedValue(undefined),
      getWorldSummary: vi.fn().mockReturnValue({}),
    } as unknown as FoundryClient;

    const result = await handleRefreshWorldData({}, client);
    const text = getText(result);

    expect(text).toContain('World data refreshed successfully.');
  });
});

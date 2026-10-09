import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  ActorItemListOutput,
  ActorItemOutput,
  ActorSectionOutput,
  ActorSheetOutput,
} from '../../../foundry/actor-sheet-contract.js';
import type { FoundryClient } from '../../../foundry/client.js';
import { PaginationCursorError } from '../../../foundry/pagination.js';
import {
  handleGetActorItem,
  handleGetActorSection,
  handleGetActorSheet,
  handleListActorItems,
} from '../actors.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

const ACTOR_ID = 'Actor00000000001';
const ITEM_ID = 'Item000000000001';
const actor = {
  id: ACTOR_ID,
  uuid: `Actor.${ACTOR_ID}` as const,
  name: 'Actor',
  type: 'npc',
};
const system = { id: 'dnd5e', version: '6.0.6', profile: 'dnd5e' as const };

function client(methods: Record<string, unknown>): FoundryClient {
  return methods as unknown as FoundryClient;
}

function sheet(): ActorSheetOutput {
  return {
    schemaVersion: 1,
    documentType: 'ActorSheet',
    actor,
    system,
    sections: [
      'attributes',
      'abilities',
      'skills',
      'details',
      'currency',
      'resources',
      'system',
    ].map((name) => ({ name, supported: true, fieldCount: 0 })) as ActorSheetOutput['sections'],
    itemCount: 1,
    readMetadata: readMetadata(),
  };
}

function section(): ActorSectionOutput {
  return {
    schemaVersion: 1,
    documentType: 'ActorSection',
    actor,
    system,
    section: 'attributes',
    supported: true,
    fields: [
      {
        key: 'hp.value',
        label: 'Hit Points',
        source: 'normalized',
        path: 'system.attributes.hp.value',
        present: true,
        value: 0,
      },
    ],
    readMetadata: readMetadata(),
  };
}

function items(): ActorItemListOutput {
  return {
    schemaVersion: 1,
    documentType: 'ActorItemCollection',
    actor,
    records: [
      {
        id: ITEM_ID,
        uuid: `Actor.${ACTOR_ID}.Item.${ITEM_ID}`,
        name: 'Coin',
        type: 'loot',
        quantity: 0,
      },
    ],
    ...paginationMetadata(1),
  };
}

function item(): ActorItemOutput {
  return {
    schemaVersion: 1,
    documentType: 'ActorItem',
    actor,
    item: {
      id: ITEM_ID,
      uuid: `Actor.${ACTOR_ID}.Item.${ITEM_ID}`,
      parentActorId: ACTOR_ID,
      name: 'Coin',
      type: 'loot',
      quantity: 0,
      fields: [],
      systemFieldsSupported: true,
    },
    readMetadata: readMetadata(),
  };
}

describe('actor sheet structured read handlers', () => {
  it('calls each client read and returns matching structured and text JSON', async () => {
    const methods = {
      getActorSheet: vi.fn().mockReturnValue(sheet()),
      getActorSection: vi.fn().mockReturnValue(section()),
      listActorItems: vi.fn().mockReturnValue(items()),
      getActorItem: vi.fn().mockReturnValue(item()),
    };
    const foundry = client(methods);
    const results = [
      await handleGetActorSheet({ actorId: ACTOR_ID }, foundry),
      await handleGetActorSection({ actorId: ACTOR_ID, section: 'attributes' }, foundry),
      await handleListActorItems(
        { actorId: ACTOR_ID, query: 'coin', type: 'loot', limit: 1 },
        foundry,
      ),
      await handleGetActorItem({ actorId: ACTOR_ID, itemId: ITEM_ID }, foundry),
    ];
    expect(methods.getActorSheet).toHaveBeenCalledWith(ACTOR_ID);
    expect(methods.getActorSection).toHaveBeenCalledWith(ACTOR_ID, 'attributes');
    expect(methods.listActorItems).toHaveBeenCalledWith({
      actorId: ACTOR_ID,
      query: 'coin',
      type: 'loot',
      limit: 1,
    });
    expect(methods.getActorItem).toHaveBeenCalledWith(ACTOR_ID, ITEM_ID);
    for (const result of results) {
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    }
  });

  it('validates IDs, section names, and list bounds before client lookup', async () => {
    const methods = {
      getActorSheet: vi.fn(),
      getActorSection: vi.fn(),
      listActorItems: vi.fn(),
      getActorItem: vi.fn(),
    };
    const foundry = client(methods);
    await expect(handleGetActorSheet({ actorId: 'bad' }, foundry)).rejects.toThrow(McpError);
    await expect(
      handleGetActorSection({ actorId: ACTOR_ID, section: 'secrets' }, foundry),
    ).rejects.toThrow(McpError);
    await expect(handleListActorItems({ actorId: ACTOR_ID, limit: 101 }, foundry)).rejects.toThrow(
      McpError,
    );
    await expect(
      handleGetActorItem({ actorId: ACTOR_ID, itemId: '../escape' }, foundry),
    ).rejects.toThrow(McpError);
    expect(Object.values(methods).every((method) => method.mock.calls.length === 0)).toBe(true);
  });

  it('rejects an oversized complete MCP response even when individual fields fit', async () => {
    const oversized: ActorSectionOutput = {
      ...section(),
      fields: Array.from({ length: 64 }, (_, index) => ({
        key: `field${index}`,
        label: `Field ${index}`,
        source: 'system-path' as const,
        path: `system.field${index}`,
        present: true,
        value: String(index).padStart(2, '0') + 'x'.repeat(4094),
      })),
    };
    await expect(
      handleGetActorSection(
        { actorId: ACTOR_ID, section: 'attributes' },
        client({ getActorSection: vi.fn().mockReturnValue(oversized) }),
      ),
    ).rejects.toThrow(McpError);
  });

  it('rejects unexpected private properties in client output', async () => {
    const leaked = { ...item(), item: { ...item().item, flags: { secret: true } } };
    await expect(
      handleGetActorItem(
        { actorId: ACTOR_ID, itemId: ITEM_ID },
        client({ getActorItem: vi.fn().mockReturnValue(leaked) }),
      ),
    ).rejects.toThrow(McpError);
  });

  it('wraps inventory backend failures without classifying them as cursor errors', async () => {
    await expect(
      handleListActorItems(
        { actorId: ACTOR_ID },
        client({
          listActorItems: vi.fn(() => {
            throw new Error('Inventory backend unavailable');
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Inventory backend unavailable'),
    });
  });

  it.each([
    { mode: 'service', delegated: false, message: 'Pagination cursor is malformed' },
    { mode: 'delegated', delegated: true, message: 'Pagination cursor unavailable' },
  ])('returns InvalidParams for $mode inventory cursor failures', async ({
    delegated,
    message,
  }) => {
    const foundry = client({
      isDelegatedMode: vi.fn().mockReturnValue(delegated),
      listActorItems: vi.fn(() => {
        throw new PaginationCursorError('Pagination cursor is malformed');
      }),
    });

    await expect(
      handleListActorItems({ actorId: ACTOR_ID, cursor: 'invalid' }, foundry),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining(message),
    });
  });
});

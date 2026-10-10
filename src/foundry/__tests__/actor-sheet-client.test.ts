import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../client.js';
import type { WorldActor, WorldData, WorldItem } from '../types.js';

vi.mock('axios');
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function id(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(15, '0')}`;
}

function requireCursor(cursor: string | null): string {
  if (!cursor) {
    throw new Error('expected cursor');
  }
  return cursor;
}

function ownedItem(index: number, overrides: Partial<WorldItem> = {}): WorldItem {
  return {
    _id: id('I', index),
    name: `Loot ${String(index).padStart(3, '0')}`,
    type: 'loot',
    system: { quantity: index === 0 ? 0 : 1, description: { value: '<p>Public</p>' } },
    flags: { secret: 'never' },
    ownership: { default: -1 },
    ...overrides,
  };
}

function socketClient(itemCount = 251) {
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
  const actorId = id('A', 1);
  const otherActorId = id('A', 2);
  const actor: WorldActor = {
    _id: actorId,
    name: 'Fixture Actor',
    type: 'npc',
    system: {
      attributes: { hp: { value: 0, max: 23 }, ac: { value: 10 } },
      currency: { gp: 0 },
      details: { biography: { value: '<p>Visible</p><section class="secret">hidden</section>' } },
    },
    items: Array.from({ length: itemCount }, (_, index) => ownedItem(index)),
    flags: { secret: 'never' },
    ownership: { default: -1 },
    prototypeToken: { secret: 'never' },
  };
  const world: WorldData = {
    userId: id('U', 1),
    release: {},
    world: { id: 'world-1', title: 'World' },
    system: { id: 'dnd5e', version: '6.0.6' },
    modules: [],
    demoMode: false,
    actors: [
      actor,
      { _id: otherActorId, name: 'Other', type: 'npc', system: {}, items: [ownedItem(999)] },
    ],
    items: [],
    scenes: [],
    journal: [],
    users: [
      { _id: id('U', 1), name: 'GM', role: 4, color: '#000' },
      { _id: id('U', 2), name: 'Other GM', role: 4, color: '#111' },
    ],
    messages: [],
    combats: [],
    activeUsers: [id('U', 1)],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
  };
  Reflect.set(client, 'worldData', world);
  Reflect.set(client, 'snapshotWorldId', world.world.id);
  Reflect.set(client, 'snapshotId', 'world-snapshot-1');
  Reflect.set(client, 'snapshotRevision', 1);
  Reflect.set(client, 'snapshotCapturedAt', '2026-01-01T00:00:00.000Z');
  Reflect.set(client, 'snapshotObservedAt', '2026-01-01T00:00:01.000Z');
  return { client, world, actor, actorId, otherActorId };
}

beforeEach(() => {
  vi.mocked(axios.create).mockReturnValue({
    get: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as unknown as ReturnType<typeof axios.create>);
});

describe('structured actor sheet client reads', () => {
  it('returns bounded public sheet, section, inventory, and parent-qualified item records', () => {
    const { client, actorId } = socketClient();
    expect(client.getActorSheet(actorId)).toMatchObject({
      schemaVersion: 1,
      documentType: 'ActorSheet',
      actor: { id: actorId, uuid: `Actor.${actorId}` },
      system: { id: 'dnd5e', version: '6.0.6', profile: 'dnd5e' },
      itemCount: 251,
    });
    const attributes = client.getActorSection(actorId, 'attributes');
    expect(attributes.fields).toContainEqual(
      expect.objectContaining({ key: 'hp.value', present: true, value: 0 }),
    );
    expect(JSON.stringify(attributes)).not.toMatch(/flags|ownership|prototypeToken|hidden/);

    const first = client.listActorItems({ actorId, limit: 100 });
    expect(first.records).toHaveLength(100);
    expect(first.total).toBe(251);
    expect(first.records[0]).toMatchObject({ quantity: 0 });
    const item = client.getActorItem(actorId, first.records[0].id);
    expect(item.item).toMatchObject({
      parentActorId: actorId,
      uuid: `Actor.${actorId}.Item.${first.records[0].id}`,
    });
    expect(JSON.stringify(item)).not.toMatch(/flags|ownership|secret/);
  });

  it('returns empty inventories and all 251 records exactly once across pages', () => {
    const empty = socketClient(0);
    expect(empty.client.listActorItems({ actorId: empty.actorId })).toMatchObject({
      records: [],
      total: 0,
      complete: true,
    });

    const { client, actorId } = socketClient();
    const ids: string[] = [];
    let page = client.listActorItems({ actorId, limit: 37 });
    for (;;) {
      ids.push(...page.records.map((item) => item.id));
      if (!page.nextCursor) {
        break;
      }
      page = client.listActorItems({ actorId, cursor: page.nextCursor });
    }
    expect(ids).toHaveLength(251);
    expect(new Set(ids).size).toBe(251);
  });

  it('preserves cursor source metadata when a newer world snapshot is observed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-01-01T00:00:04.000Z');
      const { client, actorId } = socketClient();
      const first = client.listActorItems({ actorId, limit: 1 });
      Reflect.set(client, 'snapshotId', 'world-snapshot-2');
      Reflect.set(client, 'snapshotRevision', 2);
      Reflect.set(client, 'snapshotCapturedAt', '2026-01-01T00:00:02.000Z');
      Reflect.set(client, 'snapshotObservedAt', '2026-01-01T00:00:03.000Z');
      vi.setSystemTime('2026-01-01T00:00:05.000Z');
      const second = client.listActorItems({ actorId, cursor: requireCursor(first.nextCursor) });
      expect(second.readMetadata).toMatchObject({
        snapshotId: first.readMetadata.snapshotId,
        revision: first.readMetadata.revision,
        capturedAt: first.readMetadata.capturedAt,
        observedAt: first.readMetadata.observedAt,
        freshness: 'stale',
        respondedAt: '2026-01-01T00:00:05.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'field edit',
      (actor: WorldActor) => {
        const item = actor.items?.[0];
        if (item) {
          item.system.quantity = 7;
        }
      },
    ],
    ['deletion', (actor: WorldActor) => actor.items?.splice(0, 1)],
    [
      'sort edit',
      (actor: WorldActor) => {
        const item = actor.items?.[0];
        if (item) {
          item.sort = 999;
        }
      },
    ],
  ])('invalidates a continuation after an item %s', (_label, mutate) => {
    const { client, actor, actorId } = socketClient();
    const first = client.listActorItems({ actorId, limit: 1 });
    mutate(actor);
    expect(() =>
      client.listActorItems({ actorId, cursor: requireCursor(first.nextCursor) }),
    ).toThrow(/query, world, or caller/);
  });

  it('binds continuations to actor, query, caller, and socket session', () => {
    const { client, world, actorId, otherActorId } = socketClient();
    const first = client.listActorItems({ actorId, query: 'Loot', limit: 1 });
    const cursor = requireCursor(first.nextCursor);
    expect(() => client.listActorItems({ actorId, query: 'Other', cursor })).toThrow(
      /query, world, or caller/,
    );
    expect(() => client.listActorItems({ actorId: otherActorId, query: 'Loot', cursor })).toThrow(
      /query, world, or caller/,
    );
    world.userId = id('U', 2);
    expect(() => client.listActorItems({ actorId, query: 'Loot', cursor })).toThrow(
      /query, world, or caller/,
    );
    world.userId = id('U', 1);
    Reflect.set(client, 'paginationSession', 'replacement-session');
    expect(() => client.listActorItems({ actorId, query: 'Loot', cursor })).toThrow(
      /query, world, or caller/,
    );
  });

  it('uses the same item error for missing actors, absent items, and wrong parents', () => {
    const { client, actorId, otherActorId } = socketClient();
    const missingItem = id('I', 998);
    const otherItem = id('I', 999);
    for (const read of [
      () => client.getActorItem(id('A', 998), missingItem),
      () => client.getActorItem(actorId, missingItem),
      () => client.getActorItem(actorId, otherItem),
      () => client.getActorItem(otherActorId, id('I', 0)),
    ]) {
      expect(read).toThrow('Actor item read unavailable');
    }
  });

  it('strictly validates IDs before lookup and fails REST reads as unsupported', () => {
    const { client } = socketClient();
    expect(() => client.getActorSheet('bad')).toThrow(/actorId/);
    expect(() => client.getActorItem(id('A', 1), 'bad')).toThrow(/itemId/);
    const rest = new FoundryClient({ baseUrl: 'http://localhost:30000', apiKey: 'key' });
    expect(() => rest.getActorSheet(id('A', 1))).toThrow(/unsupported by the REST backend/);
  });
});

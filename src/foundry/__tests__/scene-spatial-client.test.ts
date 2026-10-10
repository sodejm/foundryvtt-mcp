import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../client.js';
import type { WorldData, WorldScene } from '../types.js';

vi.mock('axios');
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const USER = 'User000000000001';
const OTHER_USER = 'User000000000002';
const SCENE = 'Scene00000000001';
const OTHER_SCENE = 'Scene00000000002';

function token(index: number) {
  return {
    _id: `Token${String(index).padStart(11, '0')}`,
    name: `Token ${String(index).padStart(3, '0')}`,
    x: index === 0 ? 0 : -index,
    y: index,
    width: 1,
    height: 2,
    rotation: 0,
    elevation: 0,
    hidden: false,
    texture: { src: `tokens/${index}.webp`, scaleX: 4, scaleY: 0.25 },
  };
}

function scene(id: string, active: boolean, count: number): WorldScene {
  return {
    _id: id,
    name: active ? 'Active Scene' : 'Other Scene',
    active,
    navigation: true,
    width: 1200,
    height: 800,
    padding: 0.2,
    shiftX: 30,
    shiftY: -25,
    grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    tokens: Array.from({ length: count }, (_, index) => token(index)),
    darkness: 0,
    globalLight: false,
    ownership: { default: 0, [USER]: 2, [OTHER_USER]: 2 },
  } as WorldScene;
}

function fixture(count = 205) {
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
  const active = scene(SCENE, true, count);
  const other = scene(OTHER_SCENE, false, 2);
  const world: WorldData = {
    userId: USER,
    release: {},
    world: { id: 'world-1' },
    system: { id: 'system-1' },
    modules: [],
    demoMode: false,
    actors: [],
    items: [],
    scenes: [active, other],
    journal: [],
    messages: [],
    combats: [],
    users: [
      { _id: USER, name: 'User', role: 1, color: '#000000' },
      { _id: OTHER_USER, name: 'Other', role: 1, color: '#111111' },
    ],
    activeUsers: [USER],
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
  Reflect.set(client, 'snapshotId', 'source-snapshot-1');
  Reflect.set(client, 'snapshotRevision', 1);
  Reflect.set(client, 'snapshotCapturedAt', '2026-01-01T00:00:00.000Z');
  Reflect.set(client, 'snapshotObservedAt', '2026-01-01T00:00:01.000Z');
  return { client, world, active, other };
}

function cursor(value: string | null): string {
  if (!value) {
    throw new Error('expected cursor');
  }
  return value;
}

beforeEach(() => {
  vi.mocked(axios.create).mockReturnValue({
    get: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as unknown as ReturnType<typeof axios.create>);
});

describe('structured scene spatial client reads', () => {
  it('selects the active scene and traverses a large token collection exactly once', () => {
    const { client } = fixture();
    expect(client.getSceneSpatial()).toMatchObject({
      scene: { id: SCENE, dimensions: { originXPixels: 270, originYPixels: 225 } },
    });

    const ids: string[] = [];
    let page = client.listSceneTokens({ limit: 37 });
    for (;;) {
      ids.push(...page.records.map((record) => record.id));
      expect(page.records.every((record) => !('texture' in record))).toBe(true);
      if (!page.nextCursor) {
        break;
      }
      page = client.listSceneTokens({ cursor: page.nextCursor });
    }
    expect(ids).toHaveLength(205);
    expect(new Set(ids).size).toBe(205);
    const firstId = ids[0];
    if (firstId === undefined) {
      throw new Error('expected at least one token ID');
    }
    expect(client.getSceneToken(undefined, firstId)).toMatchObject({
      token: { id: firstId, texture: { scaleX: 4, scaleY: 0.25 } },
    });
  });

  it('validates IDs before lookup and uses generic denied-or-absent failures', () => {
    const { client } = fixture();
    expect(() => client.getSceneSpatial('../bad')).toThrow(/Invalid sceneId format/);
    expect(() => client.getSceneSpatial('Scene00000000999')).toThrow(
      'Scene spatial read unavailable',
    );
    expect(() => client.getSceneToken(undefined, 'Token00000000999')).toThrow(
      'Scene token read unavailable',
    );
  });

  it('binds continuations to query, scene, active selection, source, caller, and session', () => {
    const makeCursor = () => {
      const { client, world, active, other } = fixture();
      return {
        client,
        world,
        active,
        other,
        value: cursor(client.listSceneTokens({ query: 'Token', limit: 1 }).nextCursor),
      };
    };

    let f = makeCursor();
    expect(() => f.client.listSceneTokens({ query: 'Other', cursor: f.value })).toThrow(
      /query, world, or caller/,
    );
    f = makeCursor();
    expect(() =>
      f.client.listSceneTokens({ sceneId: OTHER_SCENE, query: 'Token', cursor: f.value }),
    ).toThrow(/query, world, or caller/);
    f = makeCursor();
    f.active.active = false;
    f.other.active = true;
    expect(() => f.client.listSceneTokens({ query: 'Token', cursor: f.value })).toThrow(
      /query, world, or caller/,
    );
    f = makeCursor();
    const firstToken = f.active.tokens[0];
    if (firstToken === undefined) {
      throw new Error('expected at least one active-scene token');
    }
    firstToken.x = 999;
    expect(() => f.client.listSceneTokens({ query: 'Token', cursor: f.value })).toThrow(
      /query, world, or caller/,
    );
    f = makeCursor();
    f.world.userId = OTHER_USER;
    expect(() => f.client.listSceneTokens({ query: 'Token', cursor: f.value })).toThrow(
      /query, world, or caller/,
    );
    f = makeCursor();
    Reflect.set(f.client, 'paginationSession', 'replacement-session');
    expect(() => f.client.listSceneTokens({ query: 'Token', cursor: f.value })).toThrow(
      /query, world, or caller/,
    );
  });

  it('rejects REST scene spatial reads rather than returning an unproven projection', () => {
    const client = new FoundryClient({ baseUrl: 'http://localhost:30000', apiKey: 'key' });
    expect(() => client.getSceneSpatial()).toThrow(/unsupported by the REST backend/);
  });
});

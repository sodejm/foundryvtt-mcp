import { describe, expect, it } from 'vitest';
import {
  MAX_SPATIAL_SOURCE_RECORDS,
  projectSceneSpatial,
  sceneSpatialOutputSchema,
  sceneTokenListOutputSchema,
  sceneTokenOutputSchema,
} from '../scene-spatial-contract.js';
import type { WorldActor, WorldData, WorldScene, WorldUser } from '../types.js';

const USER_A = 'User000000000001';
const USER_B = 'User000000000002';
const SCENE = 'Scene00000000001';
const ACTOR = 'Actor00000000001';

function user(id = USER_A, role = 1): WorldUser {
  return { _id: id, name: id, role, color: '#000000' };
}

function actor(overrides: Partial<WorldActor> = {}): WorldActor {
  return {
    _id: ACTOR,
    name: 'Actor',
    type: 'npc',
    system: {},
    ownership: { default: 0, [USER_A]: 2 },
    ...overrides,
  };
}

function token(index: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: `Token${String(index).padStart(11, '0')}`,
    name: `Token ${index}`,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    elevation: 0,
    hidden: false,
    ...overrides,
  };
}

function scene(
  type = 1,
  overrides: Partial<WorldScene> & Record<string, unknown> = {},
): WorldScene {
  return {
    _id: SCENE,
    name: 'Scene',
    active: true,
    navigation: true,
    width: 1234,
    height: 987,
    padding: 0.2,
    grid: { type, size: 100, distance: 0, units: '' },
    tokens: [],
    darkness: 0,
    globalLight: false,
    ownership: { default: 0, [USER_A]: 2, [USER_B]: 2 },
    shiftX: 30,
    shiftY: -25,
    ...overrides,
  } as WorldScene;
}

function world(scenes: WorldScene[], actors: WorldActor[] = []): WorldData {
  return {
    userId: USER_A,
    release: {},
    world: { id: 'world' },
    system: { id: 'system' },
    modules: [],
    demoMode: false,
    actors,
    scenes,
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [user(), user(USER_B)],
    activeUsers: [USER_A],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
  };
}

function projected(type: number, overrides: Partial<WorldScene> & Record<string, unknown> = {}) {
  return projectSceneSpatial(world([scene(type, overrides)]), user()).scenes[0];
}

describe('scene spatial projection', () => {
  it.each([
    [0, 1834, 1387, 270, 225, 1387, 1834],
    [1, 1834, 1387, 270, 225, 14, 19],
    [2, 1900, 1501.110699893027, 320, 284.8076211353316, 17, 20],
    [3, 1900, 1501.110699893027, 320, 284.8076211353316, 17, 20],
    [4, 1760.9183210283588, 1500, 229.8076211353316, 275, 16, 20],
    [5, 1760.9183210283588, 1500, 229.8076211353316, 275, 16, 20],
  ])('matches native padded dimensions for grid type %i', (type, width, height, originX, originY, rows, columns) => {
    const dimensions = projected(type)?.scene.dimensions;
    expect(dimensions?.widthPixels).toBeCloseTo(width, 11);
    expect(dimensions?.heightPixels).toBeCloseTo(height, 11);
    expect(dimensions?.originXPixels).toBeCloseTo(originX, 11);
    expect(dimensions?.originYPixels).toBeCloseTo(originY, 11);
    expect(dimensions).toMatchObject({ rows, columns, derivation: 'foundry-native' });
  });

  it.each([
    [2, 12, 13],
    [3, 12, 13],
    [4, 11, 14],
    [5, 11, 14],
  ])('preserves native dimensions for zero-padding hex type %i', (type, rows, columns) => {
    const result = projected(type, { padding: 0 })?.scene;
    expect(result?.dimensions).toMatchObject({
      widthPixels: 1234,
      heightPixels: 987,
      originXPixels: -30,
      originYPixels: 25,
      rows,
      columns,
    });
  });

  it('uses reciprocal grid padding and preserves omitted values separately from zero', () => {
    const boundary = projected(1, {
      width: 1000,
      height: 1000,
      padding: 0.3,
      grid: { type: 1, size: 100, distance: 0, units: '' },
      shiftX: 0,
      shiftY: 0,
    })?.scene;
    expect(boundary?.dimensions).toMatchObject({ widthPixels: 1600, heightPixels: 1600 });
    expect(boundary?.source).toMatchObject({ shiftXPixels: 0, shiftYPixels: 0 });
    expect(boundary?.grid).toMatchObject({ distance: 0, distanceUnits: '' });

    const omitted = projected(1, {
      grid: { type: 1, size: 100 },
      shiftX: undefined,
      shiftY: undefined,
    })?.scene;
    expect(omitted?.source).toMatchObject({ shiftXPixels: 0, shiftYPixels: 0 });
    expect(omitted?.grid).not.toHaveProperty('distance');
    expect(omitted?.grid).not.toHaveProperty('distanceUnits');
  });

  it.each([
    { grid: { type: 6, size: 100 } },
    { grid: { type: -1, size: 100 } },
    { grid: { type: 1, size: 0 } },
    { grid: { type: 1, size: 100, distance: -1 } },
    { width: 0 },
    { height: -1 },
    { padding: 1.01 },
    { shiftX: Number.POSITIVE_INFINITY },
  ])('excludes unsupported or invalid scene source: %j', (overrides) => {
    expect(projected(1, overrides)).toBeUndefined();
  });

  it.each([
    { ownership: null },
    { ownership: 'invalid' },
    { ownership: [] },
    { ownership: { '': 2 } },
    { ownership: { [USER_A]: 1.5 } },
    { ownership: { [USER_A]: -2 } },
    { ownership: { [USER_A]: 4 } },
    { ownership: {} },
    { _id: 'bad' },
    { name: 42 },
    { name: 'x'.repeat(513) },
    { active: 'yes' },
    { width: '1234' },
    { width: Number.POSITIVE_INFINITY },
    { height: '987' },
    { height: Number.NaN },
    { padding: '0.2' },
    { padding: -0.01 },
    { shiftY: Number.NEGATIVE_INFINITY },
    { grid: null },
    { grid: 'square' },
    { grid: [] },
    { grid: { type: '1', size: 100 } },
    { grid: { type: 1.5, size: 100 } },
    { grid: { type: 1, size: '100' } },
    { grid: { type: 1, size: Number.NaN } },
    { grid: { type: 1, size: 100, distance: '5' } },
    { grid: { type: 1, size: 100, units: 5 } },
    { grid: { type: 1, size: 100, units: 'x'.repeat(129) } },
    { tokens: null },
  ])('fails closed for malformed scene fields: %j', (overrides) => {
    expect(projected(1, overrides)).toBeUndefined();
  });

  it('caps source traversal before projecting scenes and actors', () => {
    const repeatedScenes = Array.from({ length: MAX_SPATIAL_SOURCE_RECORDS + 1 }, () => scene());
    expect(() => projectSceneSpatial(world(repeatedScenes), user())).toThrow(/source exceeds/);
    const repeatedActors = Array.from({ length: MAX_SPATIAL_SOURCE_RECORDS + 1 }, () => actor());
    expect(() => projectSceneSpatial(world([scene()], repeatedActors), user())).toThrow(
      /source exceeds/,
    );
    expect(
      projectSceneSpatial(
        world([
          scene(1, {
            tokens: Array.from({ length: MAX_SPATIAL_SOURCE_RECORDS + 1 }, (_, i) => token(i)),
          }),
        ]),
        user(),
      ).scenes,
    ).toEqual([]);
  });

  it('keeps coordinate, elevation, texture, and footprint units independent', () => {
    const visible = token(1, {
      x: -25,
      y: -50,
      width: 2.5,
      height: 0.5,
      rotation: -45,
      elevation: -10,
      texture: { src: '', scaleX: 0, scaleY: -2 },
    });
    const noElevation = token(2, { elevation: undefined, texture: undefined });
    const invalid = token(3, { texture: { scaleX: Number.POSITIVE_INFINITY } });
    const result = projectSceneSpatial(
      world([scene(1, { tokens: [visible, noElevation, invalid] })]),
      user(),
    ).scenes[0];
    expect(result?.tokens).toHaveLength(2);
    expect(result?.tokens[0]).toMatchObject({
      xPixels: -25,
      yPixels: -50,
      widthGridSpaces: 2.5,
      heightGridSpaces: 0.5,
      rotationDegrees: -45,
      elevation: -10,
      elevationUnits: 'scene-distance',
      texture: { src: '', scaleX: 0, scaleY: -2 },
    });
    expect(result?.tokens[1]).not.toHaveProperty('elevation');
  });

  it('fails closed for each malformed token field and texture component', () => {
    const malformed = [
      token(1, { _id: 'bad' }),
      token(2, { name: 42 }),
      token(3, { name: 'x'.repeat(513) }),
      token(4, { x: '0' }),
      token(5, { x: Number.NaN }),
      token(6, { y: '0' }),
      token(7, { y: Number.POSITIVE_INFINITY }),
      token(8, { width: '1' }),
      token(9, { width: 0 }),
      token(10, { height: '1' }),
      token(11, { height: -1 }),
      token(12, { rotation: '0' }),
      token(13, { rotation: Number.NaN }),
      token(14, { hidden: 0 }),
      token(15, { elevation: '0' }),
      token(16, { texture: 'art.webp' }),
      token(17, { texture: [] }),
      token(18, { texture: { src: null } }),
      token(19, { texture: { src: 'x'.repeat(2049) } }),
      token(20, { texture: { scaleX: null } }),
      token(21, { texture: { scaleY: null } }),
      token(22, { texture: { scaleY: Number.POSITIVE_INFINITY } }),
    ];
    const valid = [
      token(30, { elevation: null, texture: {} }),
      token(31, { elevation: undefined, texture: { src: 'art.webp' } }),
      token(32, { texture: { scaleX: -1 } }),
      token(33, { texture: { scaleY: 0 } }),
    ];
    const result = projectSceneSpatial(
      world([scene(1, { tokens: [...malformed, ...valid] })]),
      user(),
    ).scenes[0];
    expect(result?.tokens.map((entry) => entry.name)).toEqual([
      'Token 30',
      'Token 31',
      'Token 32',
      'Token 33',
    ]);
    expect(result?.tokens[0]).not.toHaveProperty('elevation');
    expect(result?.tokens[0]?.texture).toEqual({});
  });

  it('applies player, hidden, linked, actorless, dangling, and synthetic actor permissions', () => {
    const actors = [
      actor(),
      actor({
        _id: 'Actor00000000002',
        name: 'Private',
        ownership: { default: 0, [USER_B]: 2 },
      }),
      actor({
        _id: 'Actor00000000003',
        name: 'Malformed',
        ownership: { default: 0, [USER_A]: 4 },
      }),
    ];
    const tokens = [
      token(1),
      token(2, { hidden: true }),
      token(3, { actorId: ACTOR, actorLink: true }),
      token(4, { actorId: 'Actor00000000002', actorLink: true }),
      token(5, { actorId: 'Actor00000000099', actorLink: true }),
      token(6, {
        actorId: ACTOR,
        actorLink: false,
        delta: { name: 'Synthetic', ownership: { [USER_B]: 2 } },
      }),
      token(9, {
        actorId: ACTOR,
        actorLink: false,
        delta: { name: 'Nullable defaults', type: null, ownership: null },
      }),
      token(10, {
        actorId: ACTOR,
        actorLink: false,
        delta: { name: 'Merged defaults', type: null, ownership: { default: 0, [USER_B]: 2 } },
      }),
      token(7, { actorId: ACTOR, actorLink: false, delta: 'ambiguous' }),
      token(8, { actorId: 'Actor00000000003', actorLink: true }),
    ];
    const source = world([scene(1, { tokens })], actors);
    const a = projectSceneSpatial(source, user()).scenes[0]?.tokens ?? [];
    const b = projectSceneSpatial(source, user(USER_B)).scenes[0]?.tokens ?? [];
    expect(a.map((entry) => entry.name)).toEqual([
      'Token 1',
      'Token 3',
      'Token 6',
      'Token 9',
      'Token 10',
    ]);
    expect(b.map((entry) => entry.name)).toEqual(['Token 1', 'Token 4', 'Token 6', 'Token 10']);
    expect(a[2]?.actor).toMatchObject({ name: 'Synthetic', linked: false });
    expect(a[3]?.actor).toMatchObject({ name: 'Nullable defaults', type: 'npc', linked: false });

    const gm = projectSceneSpatial(source, user(USER_A, 4)).scenes[0]?.tokens ?? [];
    expect(gm.map((entry) => entry.name)).toEqual([
      'Token 1',
      'Token 2',
      'Token 3',
      'Token 4',
      'Token 6',
      'Token 9',
      'Token 10',
    ]);
  });

  it('fails closed for malformed actor references and accepts valid synthetic overrides', () => {
    const actors = [
      actor(),
      actor({ _id: 'Actor00000000002', name: 42 as unknown as string }),
      actor({ _id: 'Actor00000000003', type: 42 as unknown as string }),
      actor({ _id: 'Actor00000000004', ownership: null as unknown as WorldActor['ownership'] }),
      actor({ _id: 'Actor00000000005', ownership: { default: -1, [USER_A]: -1 } }),
      actor({ _id: 'bad', name: 'Unindexed' }),
    ];
    const tokens = [
      token(1, { actorId: 'bad', actorLink: true }),
      token(2, { actorId: 'Actor00000000002', actorLink: true }),
      token(3, { actorId: 'Actor00000000003', actorLink: true }),
      token(4, { actorId: ACTOR, actorLink: 'true' }),
      token(5, {
        actorId: 'Actor00000000004',
        actorLink: false,
        delta: { ownership: { [USER_A]: 2 } },
      }),
      token(6, {
        actorId: ACTOR,
        actorLink: false,
        delta: { ownership: [] },
      }),
      token(7, { actorId: ACTOR, actorLink: false, delta: { name: 42 } }),
      token(8, { actorId: ACTOR, actorLink: false, delta: { type: 42 } }),
      token(9, { actorId: 'Actor00000000005', actorLink: true }),
      token(10, {
        actorId: ACTOR,
        actorLink: false,
        delta: { name: null, type: 'character', ownership: null },
      }),
      token(11, { actorId: ACTOR, actorLink: false, delta: {} }),
      token(12, { actorId: '', actorLink: false }),
      token(13, { actorId: null, actorLink: false }),
    ];
    const result = projectSceneSpatial(world([scene(1, { tokens })], actors), user()).scenes[0];
    expect(result?.tokens.map((entry) => entry.name)).toEqual([
      'Token 10',
      'Token 11',
      'Token 12',
      'Token 13',
    ]);
    expect(result?.tokens[0]?.actor).toMatchObject({ name: 'Actor', type: 'character' });
    expect(result?.tokens[1]?.actor).toMatchObject({ name: 'Actor', type: 'npc' });
  });

  it('publishes strict, versioned output shapes', () => {
    const entry = projected(1);
    expect(entry).toBeDefined();
    const metadata = {
      source: 'socket',
      freshness: 'current',
      worldId: 'world',
      sessionId: 'session',
      snapshotId: 'source',
      revision: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
      respondedAt: '2026-01-01T00:00:00.000Z',
    } as const;
    expect(
      sceneSpatialOutputSchema.safeParse({
        schemaVersion: 1,
        documentType: 'Scene',
        scene: entry?.scene,
        readMetadata: metadata,
      }).success,
    ).toBe(true);
    expect(
      sceneTokenListOutputSchema.safeParse({
        schemaVersion: 1,
        documentType: 'Token',
        scene: entry
          ? { id: entry.scene.id, uuid: entry.scene.uuid, name: entry.scene.name, active: true }
          : undefined,
        records: [],
        total: 0,
        page: 1,
        limit: 10,
        returnedCount: 0,
        nextCursor: null,
        complete: true,
        snapshotId: 'page',
        expiresAt: '2099-01-01T00:00:00.000Z',
        consistency: 'snapshot',
        readMetadata: metadata,
      }).success,
    ).toBe(true);
    expect(
      sceneTokenOutputSchema.safeParse({
        schemaVersion: 1,
        documentType: 'Token',
        scene: entry?.scene,
        token: { private: true },
        readMetadata: metadata,
      }).success,
    ).toBe(false);
  });
});

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustedCallerContext } from '../caller-context.js';
import type { WorldActor, WorldData, WorldItem, WorldMessage, WorldUser } from '../types.js';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi.fn(),
  sessionSocketOptions: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../config/index.js', () => ({ config: { logLevel: 'info' } }));

const { FoundryClient } = await import('../client.js');

const SERVICE = 'Service000000001';
const PLAYER_ONE = 'Player000000001';
const PLAYER_TWO = 'Player000000002';
const GM = 'Gamemaster0000001';
const WORLD = 'world-one';

type Listener = (...args: unknown[]) => void;

function buildMockSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const worldAcks: Array<(value: unknown) => void> = [];
  const socket = {
    connected: true,
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return socket;
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return socket;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'world' && typeof ack === 'function') {
        worldAcks.push(ack as (value: unknown) => void);
      }
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  return { socket, worldAcks };
}

function user(_id: string, role = 1): WorldUser {
  return {
    _id,
    name: _id === GM ? 'GM' : _id === PLAYER_ONE ? 'Player One' : 'Player Two',
    role,
    color: '#123456',
    avatar: `${_id}.webp`,
    password: 'must-not-cross-boundary',
    flags: { secret: true },
  };
}

function actor(
  suffix: number,
  ownership: Record<string, number> | undefined,
  items?: WorldActor['items'],
): WorldActor {
  return {
    _id: `Actor${String(suffix).padStart(11, '0')}`,
    name: `Actor ${suffix}`,
    type: 'character',
    system: { hp: suffix },
    ownership,
    items,
  };
}

function message(
  suffix: number,
  author: string,
  options: Partial<WorldMessage> = {},
): WorldMessage {
  return {
    _id: `Message${String(suffix).padStart(9, '0')}`,
    type: 0,
    author,
    user: SERVICE,
    timestamp: suffix,
    content: `message ${suffix}`,
    ...options,
  };
}

function snapshot(overrides: Partial<WorldData> = {}): WorldData {
  return {
    userId: SERVICE,
    release: { version: '14.369' },
    world: { id: WORLD, title: 'Test World' },
    system: { id: 'dnd5e' },
    modules: [],
    demoMode: false,
    actors: [],
    scenes: [],
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [user(SERVICE, 4), user(PLAYER_ONE), user(PLAYER_TWO), user(GM, 3)],
    activeUsers: [SERVICE, PLAYER_ONE, PLAYER_TWO, GM],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
    ...overrides,
  };
}

function context(overrides: Partial<TrustedCallerContext> = {}): TrustedCallerContext {
  return {
    callerId: 'transport-caller-one',
    userId: PLAYER_ONE,
    worldId: WORLD,
    sessionId: 'transport-session-one',
    ...overrides,
  };
}

function delegatedClient() {
  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    authorizationMode: 'delegated',
    timeout: 100,
    retryAttempts: 0,
  });
  const mock = buildMockSocket();
  Reflect.set(client, 'socket', mock.socket);
  Reflect.set(client, 'socketGeneration', 1);
  Reflect.set(client, 'socketEpoch', 1);
  Reflect.set(client, 'socketUserId', SERVICE);
  Reflect.set(client, '_isConnected', true);
  return { client, mock };
}

async function runAuthorized<T>(
  client: InstanceType<typeof FoundryClient>,
  mock: ReturnType<typeof buildMockSocket>,
  caller: TrustedCallerContext,
  value: WorldData,
  operation: () => Promise<T> | T,
): Promise<T> {
  const index = mock.worldAcks.length;
  const pending = client.runWithCaller(caller, operation);
  expect(mock.worldAcks).toHaveLength(index + 1);
  mock.worldAcks[index]?.(structuredClone(value));
  return await pending;
}

beforeEach(() => {
  vi.mocked(axios).create = vi.fn().mockReturnValue({
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
});

describe('delegated caller authorization', () => {
  it('redacts secrets from world and actor-owned item descriptions while preserving GM data', async () => {
    const { client, mock } = delegatedClient();
    const visibleItem: WorldItem = {
      _id: 'Item000000000001',
      name: 'Visible item',
      type: 'loot',
      ownership: { default: 2 },
      system: {
        description: {
          value: '<p>Public description</p><section class="secret">ITEM_SECRET</section>',
        },
      },
    };
    const visibleActor = actor(1, { default: 2 }, [visibleItem]);
    const raw = snapshot({ actors: [visibleActor], items: [visibleItem] });
    const before = structuredClone(raw);
    await runAuthorized(client, mock, context(), raw, async () => {
      const detail = await client.getItem(visibleItem._id);
      expect(JSON.stringify(detail)).toContain('Public description');
      expect(JSON.stringify(detail)).not.toContain('ITEM_SECRET');
      expect(JSON.stringify(await client.searchItems({}))).not.toContain('ITEM_SECRET');
      const world = client.getWorldData();
      expect(JSON.stringify(world?.actors[0]?.items)).toContain('Public description');
      expect(JSON.stringify(world?.actors[0]?.items)).not.toContain('ITEM_SECRET');
      expect(JSON.stringify(world)).not.toContain('ITEM_SECRET');
    });
    expect(raw).toEqual(before);
    await runAuthorized(client, mock, context({ userId: GM }), raw, async () => {
      expect(JSON.stringify(await client.getItem(visibleItem._id))).toContain('ITEM_SECRET');
      expect(JSON.stringify(client.getWorldData()?.actors[0]?.items)).toContain('ITEM_SECRET');
    });
  });

  it('redacts actor biography secrets from player detail and section reads without changing GM data', async () => {
    const { client, mock } = delegatedClient();
    const visibleActor = actor(1, { default: 2 });
    const biography = '<p>Public biography</p><section class="secret">BIOGRAPHY_SECRET</section>';
    visibleActor.system = { details: { biography: { value: biography } } };
    const raw = snapshot({ actors: [visibleActor] });
    const before = structuredClone(raw);
    await runAuthorized(client, mock, context(), raw, async () => {
      const detail = await client.getActor(visibleActor._id);
      expect(JSON.stringify(detail)).toContain('Public biography');
      expect(JSON.stringify(detail)).not.toContain('BIOGRAPHY_SECRET');
      expect(JSON.stringify(client.getActorSection(visibleActor._id, 'details'))).not.toContain(
        'BIOGRAPHY_SECRET',
      );
      expect(JSON.stringify(client.getWorldData())).not.toContain('BIOGRAPHY_SECRET');
    });
    expect(raw).toEqual(before);
    await runAuthorized(client, mock, context({ userId: GM }), raw, async () => {
      expect(JSON.stringify(await client.getActor(visibleActor._id))).toContain('BIOGRAPHY_SECRET');
    });
  });

  it('fails closed for blind chat without recipients while retaining GM authors and explicit recipients', async () => {
    const { client, mock } = delegatedClient();
    const raw = snapshot({
      messages: [
        message(1, PLAYER_TWO, { blind: true }),
        message(2, PLAYER_TWO, { blind: true, whisper: [] }),
        message(3, PLAYER_TWO, { blind: true, whisper: [PLAYER_ONE] }),
        message(4, PLAYER_ONE, { blind: true }),
        message(5, GM, { blind: true }),
        message(6, PLAYER_TWO),
      ],
    });
    await runAuthorized(client, mock, context(), raw, () => {
      expect(client.getChatMessages(100).map((entry) => entry._id)).toEqual([
        'Message000000003',
        'Message000000006',
      ]);
      expect(client.getWorldSummary().messages).toBe(2);
    });
    await runAuthorized(client, mock, context({ userId: GM }), raw, () => {
      expect(client.getChatMessages(100).map((entry) => entry._id)).toEqual([
        'Message000000005',
        'Message000000006',
      ]);
    });
  });

  it('keeps unrelated reads available when journal or spatial projections exceed their bounds', async () => {
    const { client, mock } = delegatedClient();
    const raw = snapshot({
      actors: [actor(1, { default: 2 })],
      messages: [message(1, PLAYER_TWO)],
      journal: [
        {
          _id: 'Journal000000001',
          name: 'Large journal',
          ownership: { default: 2 },
          pages: [
            {
              _id: 'JournalPage00001',
              name: 'Large page',
              type: 'text',
              text: { content: 'x'.repeat(4 * 1024 * 1024 + 1) },
            },
          ],
        },
      ],
      scenes: [
        {
          _id: 'Scene00000000001',
          ownership: { default: 2 },
          tokens: Array.from({ length: 10_001 }, (_, index) => ({
            _id: `Token${String(index).padStart(11, '0')}`,
            actorId: 'Actor00000000001',
            x: 0,
            y: 0,
          })),
        } as never,
      ],
    });
    await runAuthorized(client, mock, context(), raw, async () => {
      expect(client.getUsers().users).toHaveLength(1);
      expect((await client.searchActors({})).total).toBe(1);
      expect(client.getChatMessages()).toHaveLength(1);
      expect(client.getWorldSummary()).toEqual({
        actors: 1,
        items: 0,
        journals: 1,
        users: 1,
        messages: 1,
      });
      expect(() => client.getJournals()).toThrow('Caller is not authorized');
      expect(() => client.listSceneTokens({ sceneId: 'Scene00000000001' })).toThrow(
        'Scene spatial read unavailable',
      );
      expect(client.getUsers().users).toHaveLength(1);
      expect((await client.searchActors({})).total).toBe(1);
    });
  });

  it('clones the authorized ACK before constructing lazy projections and excludes extra fields', async () => {
    const { client, mock } = delegatedClient();
    const raw = Object.assign(snapshot({ actors: [actor(1, { default: 2 })] }), {
      extensionState: { secret: 'EXTRA_PRIVATE_FIELD' },
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = client.runWithCaller(context(), async () => {
      entered();
      await gate;
      return client.getWorldData();
    });
    mock.worldAcks[0]?.(raw);
    await started;
    const rawActor = raw.actors[0];
    if (!rawActor) {
      throw new Error('Missing actor fixture');
    }
    rawActor.name = 'MUTATED_AFTER_AUTHORIZATION';
    rawActor.ownership = { default: 0 };
    release();
    const view = await pending;
    expect(view?.actors[0]?.name).toBe('Actor 1');
    expect(JSON.stringify(view)).not.toContain('EXTRA_PRIVATE_FIELD');
    expect(Object.isFrozen(view?.actors[0]?.system)).toBe(true);
  });

  it.each([
    0,
    -1,
    101,
    'all',
    null,
    Number.NaN,
    1.5,
  ])('rejects invalid chat getter limit %s before authorization', (limit) => {
    const { client, mock } = delegatedClient();
    expect(() => client.getChatMessages(limit as number)).toThrow(McpError);
    try {
      client.getChatMessages(limit as number);
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.InvalidParams });
    }
    expect(mock.worldAcks).toHaveLength(0);
  });

  it('redacts nested journal secrets before every player read and content search', async () => {
    const { client, mock } = delegatedClient();
    const journalId = 'Journal000000001';
    const htmlPageId = 'JournalPage00001';
    const markdownPageId = 'JournalPage00002';
    const secret =
      '<section CLASS = secret><section>NEVER_PUBLIC</section>NEVER_PUBLIC_TAIL</section>';
    const raw = snapshot({
      journal: [
        {
          _id: journalId,
          name: 'Visible journal',
          ownership: { default: 2 },
          pages: [
            {
              _id: htmlPageId,
              name: 'HTML',
              type: 'text',
              text: { format: 1, content: `<p>Visible</p>${secret}` },
            },
            {
              _id: markdownPageId,
              name: 'Markdown',
              type: 'text',
              text: { format: 2, markdown: `**Markdown needle**\n${secret}` },
            },
          ],
        },
      ],
    });
    const before = structuredClone(raw);
    await runAuthorized(client, mock, context(), raw, async () => {
      expect(JSON.stringify(client.getWorldData())).not.toContain('NEVER_PUBLIC');
      expect(JSON.stringify(client.getJournals())).not.toContain('NEVER_PUBLIC');
      expect(client.searchJournals('NEVER_PUBLIC')).toEqual([]);
      expect((await client.searchJournalsPage({ query: 'NEVER_PUBLIC' })).total).toBe(0);
      expect(
        (await client.searchJournalsPage({ query: 'Markdown needle' })).records.map(
          (record) => record.id,
        ),
      ).toEqual([journalId]);
      expect(JSON.stringify(await client.getJournalSummaryPage({ journalId }))).not.toContain(
        'NEVER_PUBLIC',
      );
      for (const format of ['text', 'source'] as const) {
        const html = await client.getJournalPageContent({ journalId, pageId: htmlPageId, format });
        expect(html.chunks.map((chunk) => chunk.content).join('')).toBe(
          format === 'source' ? '<p>Visible</p>' : 'Visible',
        );
        const markdown = await client.getJournalPageContent({
          journalId,
          pageId: markdownPageId,
          format,
        });
        expect(markdown.chunks.map((chunk) => chunk.content).join('')).toBe(
          '**Markdown needle**\n',
        );
      }
    });
    expect(raw).toEqual(before);
    await runAuthorized(client, mock, context({ userId: GM }), raw, async () => {
      expect(JSON.stringify(client.getJournals())).toContain('NEVER_PUBLIC_TAIL');
      expect(
        (await client.getJournalPageContent({ journalId, pageId: htmlPageId, format: 'source' }))
          .chunks[0]?.content,
      ).toContain('NEVER_PUBLIC_TAIL');
    });
  });

  it.each([
    'dnd5e',
    'pf2e',
  ])('filters %s unidentified and misidentified items before player counts, search and detail', async (systemId) => {
    const { client, mock } = delegatedClient();
    const identity: WorldItem = {
      _id: 'Item000000000001',
      name: 'Visible equipment',
      type: 'equipment',
      ownership: { default: 2 },
      system: { identified: true, identification: { status: 'identified' }, quantity: 0 },
    };
    const hidden: WorldItem[] = [
      {
        ...identity,
        _id: 'Item000000000002',
        name: 'NEVER_PUBLIC DND5E',
        img: 'secret.webp',
        system: {
          identified: false,
          price: { value: 5000, denomination: 'gp' },
          rarity: 'legendary',
        },
      },
      {
        ...identity,
        _id: 'Item000000000003',
        name: 'NEVER_PUBLIC PF2E',
        system: { identification: { status: 'unidentified' }, price: { value: { gp: 5000 } } },
      },
      {
        ...identity,
        _id: 'Item000000000004',
        name: 'NEVER_PUBLIC MISIDENTIFIED',
        system: { identification: { status: 'misidentified' }, rarity: 'unique' },
      },
    ];
    const actorData = actor(1, { default: 2 }, [identity, ...hidden]);
    const raw = snapshot({
      system: { id: systemId },
      actors: [actorData],
      items: [identity, ...hidden],
    });
    const before = structuredClone(raw);
    const actorId = actorData._id;
    await runAuthorized(client, mock, context(), raw, async () => {
      expect(client.getWorldSummary().items).toBe(1);
      expect(JSON.stringify(client.getWorldData())).not.toContain('NEVER_PUBLIC');
      expect(client.listActorItems({ actorId }).total).toBe(1);
      expect(client.listActorItems({ actorId, query: 'NEVER_PUBLIC' }).total).toBe(0);
      expect((await client.searchItems({ query: 'NEVER_PUBLIC' })).total).toBe(0);
      expect((await client.searchItems({})).total).toBe(1);
      for (const item of hidden) {
        expect(() => client.getActorItem(actorId, item._id)).toThrow('Actor item read unavailable');
        await expect(client.getItem(item._id)).rejects.toThrow();
      }
    });
    expect(raw).toEqual(before);
    await runAuthorized(client, mock, context({ userId: GM }), raw, async () => {
      expect(client.listActorItems({ actorId }).total).toBe(4);
      expect((await client.searchItems({ query: 'NEVER_PUBLIC' })).total).toBe(3);
      for (const item of hidden) {
        expect(client.getActorItem(actorId, item._id).item.name).toBe(item.name);
      }
    });
    const service = new FoundryClient({ baseUrl: 'http://localhost:30000' });
    Reflect.set(service, 'worldData', raw);
    expect(service.getWorldData()).toBe(raw);
  });

  it('preserves service-identity reads as the compatibility default', () => {
    const client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
    const raw = snapshot({ actors: [actor(1, { default: 0 })] });
    Reflect.set(client, 'worldData', raw);

    expect(client.isDelegatedMode()).toBe(false);
    expect(client.getWorldData()).toBe(raw);
    expect(client.getWorldSummary().actors).toBe(1);
  });

  it('requires a fresh connected socket snapshot and a well-formed trusted context', async () => {
    const { client, mock } = delegatedClient();

    expect(() => client.getWorldData()).toThrow('Caller is not authorized');
    await expect(
      client.runWithCaller({ ...context(), sessionId: '' }, () => client.getWorldData()),
    ).rejects.toThrow('Caller is not authorized');
    expect(mock.worldAcks).toHaveLength(0);

    await expect(
      runAuthorized(client, mock, context({ worldId: 'other-world' }), snapshot(), () =>
        client.getWorldData(),
      ),
    ).rejects.toThrow('Caller is not authorized');

    mock.socket.connected = false;
    await expect(client.runWithCaller(context(), () => client.getWorldData())).rejects.toThrow(
      'Caller is not authorized',
    );
  });

  it('fails closed for unknown, banned, duplicate, and malformed caller identities', async () => {
    const cases: Array<[TrustedCallerContext, WorldData]> = [
      [context({ userId: 'Unknown000000001' }), snapshot()],
      [context(), snapshot({ users: [user(SERVICE, 4), user(PLAYER_ONE, 0)] })],
      [context(), snapshot({ users: [user(SERVICE, 4), user(PLAYER_ONE), user(PLAYER_ONE)] })],
      [context(), snapshot({ users: [user(SERVICE, 4), { ...user(PLAYER_ONE), role: 5 }] })],
      [
        context(),
        snapshot({ users: [user(SERVICE, 4), { ...user(PLAYER_ONE), color: undefined as never }] }),
      ],
    ];

    for (const [caller, value] of cases) {
      const { client, mock } = delegatedClient();
      await expect(
        runAuthorized(client, mock, caller, value, () => client.getWorldData()),
      ).rejects.toThrow('Caller is not authorized');
    }
  });

  it('applies explicit, default, inherited, embedded, and journal page permissions', async () => {
    const { client, mock } = delegatedClient();
    const visibleParentItems = [
      {
        _id: 'Item000000000001',
        name: 'Inherited',
        type: 'loot',
        system: {},
        ownership: { default: -1 },
      },
      {
        _id: 'Item000000000002',
        name: 'Limited',
        type: 'loot',
        system: {},
        ownership: { [PLAYER_ONE]: 1 },
      },
      {
        _id: 'Item000000000003',
        name: 'Malformed',
        type: 'loot',
        system: {},
        ownership: { default: 9 },
      },
    ];
    const value = snapshot({
      actors: [
        actor(1, { [PLAYER_ONE]: 2 }),
        actor(2, { default: 2 }, visibleParentItems),
        actor(3, { default: 1 }),
        actor(4, undefined),
        actor(5, { default: 2, somebody: 9 }),
      ],
      items: [
        {
          _id: 'Item000000000004',
          name: 'Visible',
          type: 'loot',
          system: {},
          ownership: { default: 2 },
        },
        {
          _id: 'Item000000000005',
          name: 'Limited',
          type: 'loot',
          system: {},
          ownership: { [PLAYER_ONE]: 1, default: 3 },
        },
      ],
      journal: [
        {
          _id: 'Journal000000001',
          name: 'Visible Journal',
          ownership: { default: 2 },
          pages: [
            {
              _id: 'JPage00000000001',
              name: 'Inherited',
              type: 'text',
              ownership: { default: -1 },
            },
            {
              _id: 'JPage00000000002',
              name: 'Limited',
              type: 'text',
              ownership: { [PLAYER_ONE]: 1 },
            },
            { _id: 'JPage00000000003', name: 'Malformed', type: 'text', ownership: { default: 8 } },
          ],
        },
        { _id: 'Journal000000002', name: 'Hidden Journal', ownership: { default: 1 } },
      ],
    });

    const view = await runAuthorized(client, mock, context(), value, () => client.getWorldData());
    expect(view?.actors.map((entry) => entry._id)).toEqual([
      'Actor00000000001',
      'Actor00000000002',
    ]);
    expect(view?.actors[1]?.items?.map((entry) => entry._id)).toEqual(['Item000000000001']);
    expect(view?.items.map((entry) => entry._id)).toEqual(['Item000000000004']);
    expect(view?.journal.map((entry) => entry._id)).toEqual(['Journal000000001']);
    expect(view?.journal[0]?.pages?.map((entry) => entry._id)).toEqual(['JPage00000000001']);

    const gm = delegatedClient();
    const gmView = await runAuthorized(gm.client, gm.mock, context({ userId: GM }), value, () =>
      gm.client.getWorldData(),
    );
    expect(gmView?.actors.map((entry) => entry._id)).not.toContain('Actor00000000004');
  });

  it('does not give GMs a blanket whisper override and honors blind messages', async () => {
    const value = snapshot({
      messages: [
        message(1, PLAYER_TWO),
        message(2, PLAYER_TWO, { whisper: [PLAYER_ONE] }),
        message(3, PLAYER_TWO, { whisper: [PLAYER_TWO] }),
        message(4, PLAYER_ONE, { whisper: [PLAYER_TWO] }),
        message(5, PLAYER_ONE, { whisper: [PLAYER_TWO], blind: true }),
        message(6, PLAYER_TWO, { whisper: [PLAYER_ONE], blind: true }),
        message(7, PLAYER_TWO, { whisper: [''] }),
        message(8, GM, { whisper: [PLAYER_TWO], blind: true }),
      ],
    });
    const player = delegatedClient();
    const playerMessages = await runAuthorized(player.client, player.mock, context(), value, () =>
      player.client.getChatMessages(),
    );
    expect(playerMessages.map((entry) => entry._id)).toEqual([
      'Message000000001',
      'Message000000002',
      'Message000000004',
      'Message000000006',
    ]);

    const gm = delegatedClient();
    const gmMessages = await runAuthorized(gm.client, gm.mock, context({ userId: GM }), value, () =>
      gm.client.getChatMessages(),
    );
    expect(gmMessages.map((entry) => entry._id)).toEqual(['Message000000001', 'Message000000008']);
  });

  it('returns sanitized caller state and authorized summary counts', async () => {
    const { client, mock } = delegatedClient();
    const hiddenCharacter = actor(2, { default: 1 });
    const value = snapshot({
      actors: [actor(1, { default: 2 }), hiddenCharacter],
      scenes: [{ _id: 'Scene00000000001' } as never],
      messages: [message(1, PLAYER_ONE)],
      macros: [{ _id: 'Macro00000000001' }],
      users: [
        user(SERVICE, 4),
        { ...user(PLAYER_ONE), character: hiddenCharacter._id },
        user(PLAYER_TWO),
        user(GM, 3),
      ],
    });
    const result = await runAuthorized(client, mock, context(), value, async () => ({
      world: await client.getWorldInfo(),
      users: client.getUsers(),
      summary: client.getWorldSummary(),
      metadata: client.getReadMetadata(),
    }));

    expect(result.users).toEqual({
      users: [
        {
          _id: PLAYER_ONE,
          name: 'Player One',
          role: 1,
          color: '#123456',
          avatar: `${PLAYER_ONE}.webp`,
        },
      ],
      activeUsers: [PLAYER_ONE],
    });
    expect(result.world).toMatchObject({
      id: WORLD,
      title: 'Test World',
      created: result.metadata.capturedAt,
      modified: result.metadata.observedAt,
    });
    expect(result.summary).toEqual({ actors: 1, items: 0, journals: 0, users: 1, messages: 1 });
    expect(result.metadata).toMatchObject({
      source: 'socket',
      freshness: 'current',
      worldId: WORLD,
      sessionId: 'transport-session-one',
      revision: 1,
    });
    expect(result.metadata.snapshotId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });

  it('isolates concurrent callers and freezes projections without mutating the raw snapshot', async () => {
    const { client, mock } = delegatedClient();
    const value = snapshot({
      actors: [
        actor(1, { [PLAYER_ONE]: 2, [PLAYER_TWO]: 0 }),
        actor(2, { [PLAYER_ONE]: 0, [PLAYER_TWO]: 2 }),
      ],
    });

    const first = client.runWithCaller(context(), async () => {
      await Promise.resolve();
      return client.getWorldData();
    });
    const second = client.runWithCaller(
      context({
        callerId: 'transport-caller-two',
        userId: PLAYER_TWO,
        sessionId: 'transport-session-two',
      }),
      async () => {
        await Promise.resolve();
        return client.getWorldData();
      },
    );
    expect(mock.worldAcks).toHaveLength(2);
    mock.worldAcks[0]?.(structuredClone(value));
    mock.worldAcks[1]?.(structuredClone(value));
    const [firstView, secondView] = await Promise.all([first, second]);

    expect(firstView?.actors.map((entry) => entry._id)).toEqual(['Actor00000000001']);
    expect(secondView?.actors.map((entry) => entry._id)).toEqual(['Actor00000000002']);
    expect(Object.isFrozen(firstView)).toBe(true);
    expect(Object.isFrozen(firstView?.actors)).toBe(true);
    expect(() => firstView?.actors.push(actor(3, { default: 2 }))).toThrow();
    expect(value.actors).toHaveLength(2);
  });

  it('denies unsupported surfaces and writes while preserving operation validation errors', async () => {
    const { client, mock } = delegatedClient();
    await runAuthorized(client, mock, context(), snapshot(), async () => {
      expect(() => client.assertReadSurfaceAllowed('scenes')).toThrow('Caller is not authorized');
      expect(() => client.getScenes()).toThrow('Caller is not authorized');
      await expect(client.rollDice('1d20')).rejects.toThrow('Caller is not authorized');
      await expect(client.refreshWorldData()).rejects.toThrow('Caller is not authorized');
    });

    const expected = new McpError(ErrorCode.InvalidParams, 'safe validation detail');
    await expect(
      runAuthorized(client, mock, context(), snapshot(), () => {
        throw expected;
      }),
    ).rejects.toBe(expected);
  });

  it('binds pagination to caller, session, world, and the full authorized view', async () => {
    const { client, mock } = delegatedClient();
    const value = snapshot({ actors: [actor(1, { default: 2 }), actor(2, { default: 2 })] });
    const first = await runAuthorized(client, mock, context(), value, () =>
      client.searchActors({ limit: 1 }),
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await runAuthorized(client, mock, context(), value, () =>
      client.searchActors({ limit: 1, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.actors).toHaveLength(1);

    await expect(
      runAuthorized(client, mock, context({ sessionId: 'transport-session-other' }), value, () =>
        client.searchActors({ limit: 1, cursor: first.nextCursor ?? undefined }),
      ),
    ).rejects.toThrow('Pagination cursor does not match');

    const changedView = snapshot({
      actors: [actor(1, { default: 2 }), actor(2, { default: 2 }), actor(3, { default: 2 })],
    });
    await expect(
      runAuthorized(client, mock, context(), changedView, () =>
        client.searchActors({ limit: 1, cursor: first.nextCursor ?? undefined }),
      ),
    ).rejects.toThrow('Pagination cursor does not match');
  });
});

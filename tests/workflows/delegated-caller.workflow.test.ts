import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundryMCPServer } from '../../dist/index.js';
import { validateTrustedCallerContext } from '../../dist/foundry/caller-context.js';
import { paginationMetadata, readMetadata } from '../../src/tools/handlers/__tests__/pagination-fixture.js';

vi.hoisted(() => {
  process.env.FOUNDRY_URL = 'http://127.0.0.1:30001';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
});

// Exercise the built server and SDK protocol. Core permission decisions and real
// Foundry document ownership are covered separately; this fixture tests trust ingress.
describe('built delegated MCP transport boundary', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  async function connect(options: { resolver?: 'valid' | 'missing' | 'throws'; service?: boolean } = {}) {
    const storage = new AsyncLocalStorage<{ userId: string }>();
    const contexts: unknown[] = [];
    const metadata: Record<string, unknown>[] = [];
    let token: string | undefined = 'player-a-token';
    const actor = () => ({
      _id: storage.getStore()?.userId === 'player-b' ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa',
      name: storage.getStore()?.userId === 'player-b' ? 'Player B private actor' : 'Player A private actor',
      type: 'character',
    });
    const backend = {
      isDelegatedMode: () => !options.service,
      connect: async () => {}, disconnect: async () => {},
      assertReadSurfaceAllowed: () => {},
      runWithCaller: async (context: unknown, operation: () => unknown) => {
        const trusted = validateTrustedCallerContext(context);
        contexts.push(trusted);
        return storage.run(trusted, operation);
      },
      searchActors: async () => ({ actors: [actor()], ...paginationMetadata(1, 1, 100) }),
      getActor: async (id: string) => {
        if (id !== actor()._id) throw new Error('SECRET backend actor and credential');
        return actor();
      },
      getReadMetadata: () => readMetadata(),
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = 'authenticated-mcp-session';
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, sendOptions) => send(message, {
      ...sendOptions,
      ...(token ? { authInfo: { token, clientId: 'fixture-host', scopes: ['foundry:read'] } } : {}),
    });
    const server = new FoundryMCPServer({
      foundryClient: backend,
      ...(options.resolver !== 'missing' && { resolveCaller: (extra: Record<string, unknown>) => {
        metadata.push(extra);
        if (options.resolver === 'throws') throw new Error('SECRET resolver credential');
        const auth = extra.authInfo as { token?: string } | undefined;
        if (!auth || !['player-a-token', 'player-b-token'].includes(auth.token ?? '')) return undefined;
        return {
          callerId: auth.token, userId: auth.token === 'player-b-token' ? 'player-b' : 'player-a',
          worldId: 'test-world', sessionId: String(extra.sessionId),
        };
      } }),
    });
    await server.start(serverTransport);
    const client = new Client({ name: 'delegated-workflow', version: '1' });
    await client.connect(clientTransport);
    closers.push(() => server.shutdown(), () => client.close());
    return { client, contexts, metadata, setToken: (value?: string) => { token = value; } };
  }

  it('advertises only the eighteen verified tools and four collections', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'get_actor_details', 'get_actor_item', 'get_actor_section', 'get_actor_sheet',
      'get_chat_messages', 'get_item_details', 'get_journal',
      'get_journal_page', 'get_scene_spatial', 'get_scene_token', 'get_users',
      'get_world_summary', 'list_actor_items', 'list_scene_tokens',
      'search_actors', 'search_items', 'search_journals', 'search_world',
    ]);
    expect((await client.listResources()).resources.map(resource => resource.uri).sort())
      .toEqual(['foundry://actors', 'foundry://items', 'foundry://journals', 'foundry://users']);
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(4);
  });

  it('resolves tool and resource reads using only host authentication and session metadata', async () => {
    const { client, contexts, metadata } = await connect();
    const tool = await client.callTool({ name: 'search_actors', arguments: {}, _meta: {
      userId: 'gm', role: 4, worldId: 'other-world', sessionId: 'forged',
    } });
    const resource = await client.readResource({ uri: 'foundry://actors', _meta: { userId: 'gm' } });
    expect(JSON.stringify(tool)).toContain('Player A private actor');
    expect(JSON.stringify(resource)).toContain('Player A private actor');
    expect(contexts).toHaveLength(2);
    for (const context of contexts) expect(context).toMatchObject({
      userId: 'player-a', worldId: 'test-world', sessionId: 'authenticated-mcp-session',
    });
    for (const extra of metadata) {
      expect(Object.keys(extra).sort()).toEqual(['authInfo', 'sessionId']);
      expect(Object.isFrozen(extra)).toBe(true);
    }
  });

  it('isolates concurrent principals on a shared MCP server', async () => {
    const { client, setToken } = await connect();
    const first = client.callTool({ name: 'search_actors', arguments: {} });
    setToken('player-b-token');
    const second = client.readResource({ uri: 'foundry://actors' });
    const [a, b] = await Promise.all([first, second]);
    expect(JSON.stringify(a)).toContain('Player A private actor');
    expect(JSON.stringify(a)).not.toContain('Player B private actor');
    expect(JSON.stringify(b)).toContain('Player B private actor');
    expect(JSON.stringify(b)).not.toContain('Player A private actor');
  });

  for (const key of ['userId', 'role', 'worldId', 'sessionId', 'callerId']) {
    it(`rejects model-supplied ${key} in search arguments and resource queries`, async () => {
      const { client, contexts } = await connect();
      await expect(client.callTool({ name: 'search_actors', arguments: { [key]: 'gm' } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(client.readResource({ uri: `foundry://actors?${key}=gm` }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(contexts).toHaveLength(2);
      expect(contexts.every(context => context.userId === 'player-a')).toBe(true);
    });
  }

  for (const resolver of ['missing', 'throws'] as const) {
    it(`fails closed with a ${resolver} resolver without disclosing resolver errors`, async () => {
      const { client, contexts } = await connect({ resolver });
      for (const request of [
        () => client.callTool({ name: 'search_actors', arguments: {} }),
        () => client.readResource({ uri: 'foundry://actors' }),
      ]) {
        await expect(request()).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
        await expect(request()).rejects.not.toThrow('SECRET');
      }
      expect(contexts).toEqual([]);
    });
  }

  for (const token of [undefined, 'forged-gm-token']) {
    it(`denies ${token ? 'unknown' : 'absent'} transport authentication`, async () => {
      const { client, setToken, contexts } = await connect();
      setToken(token);
      await expect(client.callTool({ name: 'search_actors', arguments: {}, _meta: {
        authInfo: { token: 'player-a-token' }, userId: 'gm',
      } })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      expect(contexts).toEqual([]);
    });
  }

  it('redacts backend errors for a direct hidden-ID request', async () => {
    const { client } = await connect();
    await expect(client.callTool({ name: 'get_actor_details', arguments: {
      actorId: 'bbbbbbbbbbbbbbbb', userId: 'gm', role: 4,
    } })).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(client.callTool({ name: 'get_actor_details', arguments: {
      actorId: 'bbbbbbbbbbbbbbbb',
    } })).rejects.not.toThrow('SECRET');
  });

  it('denies unverified read and write surfaces even with a trusted caller', async () => {
    const { client } = await connect();
    for (const name of ['get_current_scene', 'get_token_details', 'get_combat', 'get_rules', 'get_system_diagnostics', 'create_actor']) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toBeInstanceOf(McpError);
    }
    await expect(client.readResource({ uri: 'foundry://world/settings' }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('denies rule lookup before processing input even with a trusted caller', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('lookup_rule');
    for (const args of [{ query: 'Opportunity attack', system: 'dnd5e' }, { query: '' }]) {
      await expect(client.callTool({ name: 'lookup_rule', arguments: args }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    }
  });

  it('denies error diagnosis before processing input even with a trusted caller', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('diagnose_errors');
    for (const args of [{ category: 'module' }, { category: '' }, { timeframe: 3600 }]) {
      await expect(client.callTool({ name: 'diagnose_errors', arguments: args }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    }
  });

  it.each(['generate_npc', 'generate_loot'])('denies %s before validating input even with a trusted caller', async name => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain(name);
    for (const args of [{}, { level: 0 }, { challengeRating: 31 }, { persist: true }]) {
      await expect(client.callTool({ name, arguments: args }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    }
  });

  it('keeps service-identity operation available without a caller resolver', async () => {
    const { client, contexts } = await connect({ service: true, resolver: 'missing' });
    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    expect(JSON.stringify(await client.callTool({ name: 'search_actors', arguments: {} })))
      .toContain('Player A private actor');
    expect(contexts).toEqual([]);
  });
});

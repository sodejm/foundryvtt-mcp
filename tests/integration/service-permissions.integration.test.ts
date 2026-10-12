import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../src/foundry/client.js';
import { createConnectedClient, createTestClient } from './setup.js';

type Document = Record<string, unknown> & { _id: string };
type Writer = {
  modifyDocument(
    type: string,
    action: 'create' | 'delete',
    operation: Record<string, unknown>,
  ): Promise<Document[]>;
};

describe('native service account permissions', () => {
  let gm: FoundryClient;
  const clients: FoundryClient[] = [];
  const cleanup: [string, string][] = [];
  const stamp = `MCP permission ${Date.now()}`;
  async function create(type: string, data: Record<string, unknown>): Promise<Document> {
    const [document] = await (gm as unknown as Writer).modifyDocument(type, 'create', {
      data: [data],
    });
    if (!document) throw new Error(`No ${type} fixture created`);
    cleanup.push([type, document._id]);
    return document;
  }
  beforeAll(async () => {
    gm = await createConnectedClient({ writeEnabled: true });
  });
  afterAll(async () => {
    for (const client of clients) client.disconnect();
    if (!gm) return;
    try {
      for (const [type, id] of cleanup.reverse()) {
        await (gm as unknown as Writer).modifyDocument(type, 'delete', { ids: [id] });
      }
    } finally {
      gm.disconnect();
    }
  });

  it.each([1, 2])('limits role %i to observable documents and owned mutations', async (role) => {
    const user = await create('User', { name: `${stamp} role ${role}`, role, password: '' });
    const owned = await create('Actor', {
      name: `${stamp} owned ${role}`,
      type: 'character',
      ownership: { default: 0, [user._id]: 3 },
    });
    const shared = await create('Actor', {
      name: `${stamp} shared ${role}`,
      type: 'character',
      ownership: { default: 2 },
    });
    const hidden = await create('Actor', {
      name: `${stamp} hidden ${role}`,
      type: 'character',
      ownership: { default: 0 },
    });
    const item = await create('Item', {
      name: `${stamp} shared item ${role}`,
      type: 'loot',
      ownership: { default: 2 },
    });
    const hiddenItem = await create('Item', {
      name: `${stamp} hidden item ${role}`,
      type: 'loot',
      ownership: { default: 0 },
    });
    const journal = await create('JournalEntry', {
      name: `${stamp} shared journal ${role}`,
      ownership: { default: 2 },
      pages: [
        {
          name: 'Visible',
          type: 'text',
          text: { content: '<p>Visible</p><section class="secret">PRIVATE_SENTINEL</section>' },
        },
      ],
    });
    const hiddenJournal = await create('JournalEntry', {
      name: `${stamp} hidden journal ${role}`,
      ownership: { default: 0 },
    });
    const client = createTestClient({
      username: undefined,
      userId: user._id,
      password: '',
      allowPrivilegedAccount: false,
      writeEnabled: true,
    });
    clients.push(client);
    await client.connect();
    // Core sends hidden documents too: the public projection must enforce ownership.
    const raw = Reflect.get(client, 'worldData');
    expect(raw.actors.some((actor: Document) => actor._id === hidden._id)).toBe(true);
    const ids = (await client.searchActors({ query: `${stamp}`, limit: 100 })).actors.map(
      (actor) => actor._id,
    );
    expect(ids).toContain(owned._id);
    expect(ids).toContain(shared._id);
    expect(ids).not.toContain(hidden._id);
    await expect(client.getActor(hidden._id)).rejects.toThrow(/not found/i);
    expect(client.getWorldData()!.items.some((record) => record._id === item._id)).toBe(true);
    expect(client.getWorldData()!.items.some((record) => record._id === hiddenItem._id)).toBe(
      false,
    );
    expect(client.getJournals().some((record) => record._id === journal._id)).toBe(true);
    expect(client.getJournals().some((record) => record._id === hiddenJournal._id)).toBe(false);
    expect(JSON.stringify(client.getJournals())).not.toContain('PRIVATE_SENTINEL');
    expect(client.getUsers().users.map((record) => record._id)).toEqual([user._id]);
    expect(() => client.getScenes()).toThrow(/cannot safely read scenes/i);
    expect(() => client.getCombatState()).toThrow(/cannot safely read combat/i);
    expect((await client.rollDice('1d6', undefined, 'local')).engine).toBe('local');
    await expect(
      client.updateActorAttribute(owned._id, { 'currency.gp': 1 }),
    ).resolves.toBeDefined();
    await expect(client.updateActorAttribute(shared._id, { 'currency.gp': 1 })).rejects.toThrow();
    await expect(client.updateActorAttribute(hidden._id, { 'currency.gp': 1 })).rejects.toThrow();
    const embedded = await client.createActorItem(owned._id, {
      type: 'inline',
      item: { name: 'Owned loot', type: 'loot', system: {} },
    });
    await client.updateActorItem(owned._id, embedded._id, { quantity: 2 });
    await client.deleteActorItem(owned._id, embedded._id);
    await expect(
      client.createActorItem(shared._id, {
        type: 'inline',
        item: { name: 'Denied loot', type: 'loot', system: {} },
      }),
    ).rejects.toThrow();
    const effect = await client.createActorStatusEffect(`Actor.${owned._id}`, 'prone');
    await client.deleteActorEffect(`Actor.${owned._id}`, effect._id);
    await expect(client.createActorStatusEffect(`Actor.${shared._id}`, 'prone')).rejects.toThrow();
    if (role === 1) {
      await expect(
        client.createJournalEntry(`${stamp} denied`, [{ name: 'Page', content: 'text' }]),
      ).rejects.toThrow();
    } else {
      const created = await client.createJournalEntry(`${stamp} created`, [
        { name: 'Page', content: 'text' },
      ]);
      cleanup.push(['JournalEntry', created._id]);
    }
    client.disconnect();
  });

  it('requires explicit privileged opt-in for Assistant and GM connections', async () => {
    const assistant = await create('User', { name: `${stamp} assistant`, role: 3, password: '' });
    const deniedAssistant = createTestClient({
      username: undefined,
      userId: assistant._id,
      password: '',
      allowPrivilegedAccount: false,
    });
    clients.push(deniedAssistant);
    await expect(deniedAssistant.connect()).rejects.toThrow(
      'FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT=true',
    );
    const allowed = createTestClient({
      username: undefined,
      userId: assistant._id,
      password: '',
      allowPrivilegedAccount: true,
    });
    clients.push(allowed);
    await allowed.connect();
    expect(allowed.getWorldData()!.users.length).toBeGreaterThan(1);
    allowed.disconnect();
    const deniedGM = createTestClient({ allowPrivilegedAccount: false });
    clients.push(deniedGM);
    await expect(deniedGM.connect()).rejects.toThrow('FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT=true');
  });
});

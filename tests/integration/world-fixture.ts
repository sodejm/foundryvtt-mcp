/** Owned documents for mutation tests against the explicitly disposable test world. */
import type { FoundryClient } from '../../src/foundry/client.js';
import { createConnectedClient } from './setup.js';

type DocumentType = 'Actor' | 'Scene' | 'Combat';
type DocumentRecord = Record<string, unknown> & { _id: string };
type FixtureWriter = {
  modifyDocument(
    type: string,
    action: 'create' | 'delete',
    operation: Record<string, unknown>,
  ): Promise<DocumentRecord[]>;
};

export class WorldFixture {
  private readonly owned = new Map<DocumentType, Set<string>>();
  readonly prefix = `MCP Mutation ${process.pid} ${Date.now()}`;
  private constructor(readonly client: FoundryClient) {}

  static async connect(): Promise<WorldFixture> {
    const client = await createConnectedClient({ writeEnabled: true });
    const world = client.getWorldData();
    if (world?.world.id !== 'test1world' || world.system.id !== 'dnd5e') {
      await client.disconnect();
      throw new Error('Mutation fixtures require the disposable dnd5e test1world');
    }
    return new WorldFixture(client);
  }

  private writer(): FixtureWriter {
    return this.client as unknown as FixtureWriter;
  }

  track(type: DocumentType, id: string): void {
    const ids = this.owned.get(type) ?? new Set<string>();
    ids.add(id);
    this.owned.set(type, ids);
  }

  forget(type: DocumentType, id: string): void {
    this.owned.get(type)?.delete(id);
  }

  async create(type: DocumentType, data: Record<string, unknown>): Promise<DocumentRecord> {
    const result = await this.writer().modifyDocument(type, 'create', { data: [data] });
    for (const document of result) this.track(type, document._id);
    if (result.length !== 1 || !result[0]?._id) {
      throw new Error(`Foundry did not create the owned ${type} fixture`);
    }
    return result[0];
  }

  async createActor(): Promise<string> {
    return (
      await this.create('Actor', {
        name: `${this.prefix} Actor`,
        type: 'npc',
        system: { currency: { gp: 12 } },
      })
    )._id;
  }

  async createSceneWithToken(actorId: string): Promise<{ sceneId: string; tokenId: string }> {
    const scene = await this.create('Scene', {
      name: `${this.prefix} Scene`,
      active: false,
      width: 1000,
      height: 1000,
    });
    const [token] = await this.writer().modifyDocument('Token', 'create', {
      data: [{ name: `${this.prefix} Token`, actorId, actorLink: true, x: 100, y: 200 }],
      parentUuid: `Scene.${scene._id}`,
    });
    if (!token?._id) throw new Error('Foundry did not create the owned Token fixture');
    return { sceneId: scene._id, tokenId: token._id };
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      // Embedded tokens/items/effects disappear with their owned scene/actor.
      for (const [type, ids] of [...this.owned].reverse()) {
        if (ids.size === 0) continue;
        try {
          await this.writer().modifyDocument(type, 'delete', { ids: [...ids] });
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      await this.client.disconnect();
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Mutation fixture cleanup failed');
  }
}

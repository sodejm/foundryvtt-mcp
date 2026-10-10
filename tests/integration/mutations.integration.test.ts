/** Live actor item/attribute mutations use an owned NPC and verify persisted state. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldFixture } from './world-fixture.js';

describe('Actor write operations', () => {
  let fixture: WorldFixture;
  let actorId: string;
  let createdItemId: string;
  const item = () => fixture.client.getRawActor(actorId)?.items?.find((entry) => entry._id === createdItemId);

  beforeAll(async () => {
    fixture = await WorldFixture.connect();
    actorId = await fixture.createActor();
  });

  afterAll(async () => { await fixture?.close(); });

  it('create_actor_item persists an inline item on the actor', async () => {
    const created = await fixture.client.createActorItem(actorId, {
      type: 'inline',
      item: { name: `${fixture.prefix} Item`, type: 'loot', system: { quantity: 1 } } as never,
    });
    createdItemId = (created as { _id: string })._id;
    expect(createdItemId).toMatch(/^[A-Za-z0-9]{16}$/);
    await fixture.client.refreshWorldData();
    expect(item()).toMatchObject({ name: `${fixture.prefix} Item`, system: { quantity: 1 } });
  });

  it('update_actor_item persists item system data', async () => {
    await fixture.client.updateActorItem(actorId, createdItemId, { quantity: 3 });
    await fixture.client.refreshWorldData();
    expect(item()?.system.quantity).toBe(3);
  });

  it('update_actor_attributes persists and restores currency.gp', async () => {
    const client = fixture.client;
    const gp = () => (client.getRawActor(actorId)?.system.currency as { gp?: number })?.gp;
    expect(gp()).toBe(12);
    try {
      const updated = await client.updateActorAttribute(actorId, { 'currency.gp': 13 });
      expect(updated.success).toBe(true);
      await client.refreshWorldData();
      expect(gp()).toBe(13);
    } finally {
      await client.updateActorAttribute(actorId, { 'currency.gp': 12 });
    }
    await client.refreshWorldData();
    expect(gp()).toBe(12);
  });

  it('delete_actor_item removes the item from the actor', async () => {
    await fixture.client.deleteActorItem(actorId, createdItemId);
    await fixture.client.refreshWorldData();
    expect(item()).toBeUndefined();
  });
});

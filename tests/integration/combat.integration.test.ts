/** Live combat lifecycle uses its own encounter and verifies each persisted mutation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldFixture } from './world-fixture.js';

describe('Combat write operations', () => {
  let fixture: WorldFixture;
  let actorId: string;
  let sceneId: string;
  let tokenId: string;
  let combatId: string;
  let combatantId: string;
  const combat = () => fixture.client.getWorldData()?.combats.find((entry) => entry._id === combatId);

  beforeAll(async () => {
    fixture = await WorldFixture.connect();
    actorId = await fixture.createActor();
    ({ sceneId, tokenId } = await fixture.createSceneWithToken(actorId));
  });

  afterAll(async () => { await fixture?.close(); });

  it('start_combat creates an encounter with the requested token', async () => {
    const created = await fixture.client.startCombat(sceneId, [{ tokenId, sceneId, actorId }]);
    combatId = created.combatId;
    fixture.track('Combat', combatId);
    expect(created.combatantCount).toBe(1);
    await fixture.client.refreshWorldData();
    expect(combat()).toMatchObject({ _id: combatId, scene: sceneId, active: true });
    expect(combat()?.combatants).toHaveLength(1);
    expect(combat()?.combatants[0]).toMatchObject({ tokenId, actorId });
    combatantId = combat()!.combatants[0]!._id;
  });

  it('set_initiative persists the combatant initiative', async () => {
    await fixture.client.setCombatantInitiative(combatId, combatantId, 99);
    await fixture.client.refreshWorldData();
    expect(combat()?.combatants.find((entry) => entry._id === combatantId)?.initiative).toBe(99);
  });

  it('next_turn persists updated round and turn pointers', async () => {
    await fixture.client.updateCombat(combatId, { round: 2, turn: 0 });
    await fixture.client.refreshWorldData();
    expect(combat()).toMatchObject({ round: 2, turn: 0 });
  });

  it('end_combat removes the owned encounter', async () => {
    await fixture.client.endCombat(combatId);
    fixture.forget('Combat', combatId);
    await fixture.client.refreshWorldData();
    expect(combat()).toBeUndefined();
  });
});

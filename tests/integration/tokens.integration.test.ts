/** Live token and status mutations use owned fixtures and verify persisted state. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldFixture } from './world-fixture.js';

describe('Token write operations', () => {
  let fixture: WorldFixture;
  let actorId: string;
  let sceneId: string;
  let tokenId: string;

  beforeAll(async () => {
    fixture = await WorldFixture.connect();
    actorId = await fixture.createActor();
    ({ sceneId, tokenId } = await fixture.createSceneWithToken(actorId));
  });

  afterAll(async () => { await fixture?.close(); });

  it('move_token persists new coordinates and restores them', async () => {
    const client = fixture.client;
    try {
      await client.moveToken(sceneId, tokenId, 150, 250);
      await client.refreshWorldData();
      expect(client.findToken(tokenId, sceneId)?.token).toMatchObject({ x: 150, y: 250 });
    } finally {
      await client.moveToken(sceneId, tokenId, 100, 200);
    }
    await client.refreshWorldData();
    expect(client.findToken(tokenId, sceneId)?.token).toMatchObject({ x: 100, y: 200 });
  });

  it('apply_status_effect persists and removes a status on the linked actor', async () => {
    const client = fixture.client;
    const parentUuid = `Actor.${actorId}`;
    const effect = await client.createActorStatusEffect(parentUuid, 'prone');
    try {
      expect(effect._id).toMatch(/^[A-Za-z0-9]{16}$/);
      await client.refreshWorldData();
      expect(client.getRawActor(actorId)?.effects).toContainEqual(
        expect.objectContaining({ _id: effect._id, statuses: ['prone'] }),
      );
    } finally {
      await client.deleteActorEffect(parentUuid, effect._id);
    }
    await client.refreshWorldData();
    expect(client.getRawActor(actorId)?.effects?.some((entry) => entry._id === effect._id)).toBe(false);
  });
});

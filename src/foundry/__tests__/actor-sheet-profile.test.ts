import { describe, expect, it } from 'vitest';
import {
  actorItemFields,
  actorSectionFields,
  actorSystemIdentity,
  isActorSectionSupported,
  publicActorIdentity,
  publicActorItemSummary,
} from '../actor-sheet-profile.js';
import type { WorldActor, WorldData, WorldItem } from '../types.js';

const ACTOR_ID = 'Actor00000000001';
const ITEM_ID = 'Item000000000001';

function actor(system: Record<string, unknown>): WorldActor {
  return { _id: ACTOR_ID, name: '🧙'.repeat(300), type: 'npc', system, items: [] };
}

function item(system: Record<string, unknown>): WorldItem {
  return { _id: ITEM_ID, name: 'Item', type: 'loot', system };
}

function world(system: WorldData['system']): WorldData {
  return { system } as WorldData;
}

describe('actor sheet system profiles', () => {
  it('normalizes D&D5e fields while preserving zero and missing values', () => {
    const source = actor({
      attributes: { hp: { value: 0, temp: 0 }, ac: { value: 0 } },
      details: {
        level: 0,
        biography: {
          value: '<p>Visible</p><section CLASS = secret>hidden</section><p>After</p>',
        },
      },
      currency: { gp: 0 },
    });

    const attributes = actorSectionFields(source, 'dnd5e', 'attributes', false);
    expect(attributes.find((field) => field.key === 'hp.value')).toMatchObject({
      source: 'normalized',
      path: 'system.attributes.hp.value',
      present: true,
      value: 0,
    });
    expect(attributes.find((field) => field.key === 'hp.max')).toMatchObject({
      present: false,
    });
    expect(attributes.find((field) => field.key === 'hp.max')).not.toHaveProperty('value');

    const details = actorSectionFields(source, 'dnd5e', 'details', false);
    const biography = details.find((field) => field.key === 'biography');
    expect(biography?.value).toBe('<p>Visible</p><p>After</p>');
    expect(String(biography?.value)).not.toContain('hidden');
    expect(actorSectionFields(source, 'dnd5e', 'details', true)).not.toContainEqual(
      expect.objectContaining({ key: 'biography' }),
    );

    expect(actorSectionFields(source, 'dnd5e', 'currency', false)).toContainEqual(
      expect.objectContaining({ key: 'currency.gp', present: true, value: 0 }),
    );
  });

  it('uses the documented PF2e paths and retains zero values', () => {
    const source = actor({
      attributes: { hp: { value: 0, max: 23 }, ac: { value: 17 } },
      details: { level: { value: 0 }, class: { name: 'Investigator' } },
      resources: { heroPoints: { value: 0, max: 3 } },
    });

    expect(actorSectionFields(source, 'pf2e', 'details', false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'level',
          path: 'system.details.level.value',
          present: true,
          value: 0,
        }),
        expect.objectContaining({
          key: 'class',
          path: 'system.details.class.name',
          value: 'Investigator',
        }),
      ]),
    );
    expect(actorSectionFields(source, 'pf2e', 'resources', false)).toContainEqual(
      expect.objectContaining({ key: 'heroPoints.value', value: 0 }),
    );
    expect(actorSystemIdentity(world({ id: 'PF2E', version: '6.2.0' }))).toEqual({
      id: 'pf2e',
      version: '6.2.0',
      profile: 'pf2e',
    });
  });

  it('falls back to bounded primitive system paths and omits sensitive or nested values', () => {
    const long = 'x'.repeat(4096);
    const system = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`field${String(index).padStart(2, '0')}`, long]),
    );
    Object.assign(system, {
      flags: { private: 'never' },
      credentials: { password: 'never' },
      apiKeyValue: 'never',
      gmSecretNote: 'never',
      array: ['never'],
      nested: { object: { too: { deep: { value: 'never' } } } },
      aaaZero: 0,
      unusual: { ['🧪'.repeat(200)]: true },
    });
    const fields = actorSectionFields(actor(system), 'generic', 'system', false);

    expect(fields.length).toBeLessThanOrEqual(64);
    expect(
      fields.reduce(
        (total, field) => total + (typeof field.value === 'string' ? field.value.length : 0),
        0,
      ),
    ).toBeLessThanOrEqual(8192);
    expect(fields).not.toContainEqual(
      expect.objectContaining({ path: expect.stringMatching(/flags|credential/) }),
    );
    expect(fields).not.toContainEqual(expect.objectContaining({ value: 'never' }));
    expect(fields).toContainEqual(expect.objectContaining({ path: 'system.aaaZero', value: 0 }));
    expect(
      fields.every((field) => field.key.length <= 128 && (field.path?.length ?? 0) <= 512),
    ).toBe(true);
    expect(isActorSectionSupported('generic', 'system', false)).toBe(true);
    expect(isActorSectionSupported('generic', 'system', true)).toBe(false);
    expect(actorSectionFields(actor(system), 'generic', 'system', true)).toEqual([]);
  });

  it('bounds public identities without splitting a surrogate pair', () => {
    const identity = publicActorIdentity(actor({}));
    expect(identity.name.length).toBeLessThanOrEqual(512);
    const finalCodeUnit = identity.name.charCodeAt(identity.name.length - 1);
    expect(finalCodeUnit < 0xd800 || finalCodeUnit > 0xdbff).toBe(true);
    expect(identity).not.toHaveProperty('system');
  });

  it('projects owned item summaries and omits delegated rich text', () => {
    const source = item({
      quantity: { value: 0 },
      equipped: false,
      description: { value: '<p>Visible</p><section class="secret">hidden</section>' },
    });
    expect(publicActorItemSummary(ACTOR_ID, source)).toMatchObject({
      id: ITEM_ID,
      uuid: `Actor.${ACTOR_ID}.Item.${ITEM_ID}`,
      quantity: 0,
      equipped: false,
    });
    const fields = actorItemFields(source, 'dnd5e', false);
    expect(fields).toContainEqual(expect.objectContaining({ key: 'quantity', value: 0 }));
    expect(fields.find((field) => field.key === 'description')?.value).toBe('<p>Visible</p>');
    expect(actorItemFields(source, 'dnd5e', true)).not.toContainEqual(
      expect.objectContaining({ key: 'description' }),
    );
  });
});

import { readFileSync } from 'node:fs';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  ITEM_ECONOMY_SCHEMA_VERSION,
  ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH,
  ITEM_ECONOMY_TEXT_MAX_LENGTH,
  itemEconomySchema,
} from './item-economy-contract.js';
import {
  assertItemRarityFilter,
  itemMatchesRarity,
  normalizeItemEconomy,
} from './item-normalization.js';

const dndIdentity = { id: 'dnd5e', version: '6.0.6' } as const;
const pf2eIdentity = { id: 'pf2e', version: '7.8.0' } as const;

function fixture(name: string): { type: string; system: unknown } {
  return JSON.parse(
    readFileSync(new URL(`../../tests/fixtures/item-economy/${name}`, import.meta.url), 'utf8'),
  );
}

function expectInvalidParams(run: () => unknown): void {
  try {
    run();
    throw new Error('Expected InvalidParams');
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
  }
}

describe('normalizeItemEconomy', () => {
  it('normalizes the synthetic dnd5e fixture without inventing defaults or leaking fields', () => {
    const result = normalizeItemEconomy(fixture('dnd5e-6.0.6.synthetic.json'), dndIdentity);

    expect(result).toEqual({
      schemaVersion: ITEM_ECONOMY_SCHEMA_VERSION,
      adapter: {
        systemId: 'dnd5e',
        systemVersion: '6.0.6',
        adapterId: 'dnd5e@6.0.6',
        status: 'supported',
      },
      source: {
        price: { value: 0, denomination: 'gp' },
        rarities: ['common', 'veryRare'],
      },
      price: { status: 'known', currencies: [{ denomination: 'gp', value: 0 }], per: null },
      rarity: { status: 'known', values: ['common', 'veryRare'] },
    });
  });

  it('preserves a decimal dnd5e price and a known empty rarity array', () => {
    const result = normalizeItemEconomy(
      { type: 'loot', system: { price: { value: 1.5, denomination: 'sp' }, rarities: [] } },
      dndIdentity,
    );

    expect(result.price).toEqual({
      status: 'known',
      currencies: [{ denomination: 'sp', value: 1.5 }],
      per: null,
    });
    expect(result.rarity).toEqual({ status: 'known', values: [] });
  });

  it.each([
    'consumable',
    'container',
    'equipment',
    'loot',
    'tool',
    'weapon',
  ])('treats absent economy fields on dnd5e physical type %s as missing', (type) => {
    const result = normalizeItemEconomy({ type, system: {} }, dndIdentity);
    expect(result.price.status).toBe('missing');
    expect(result.rarity.status).toBe('missing');
  });

  it.each([
    'background',
    'class',
    'facility',
    'feat',
    'race',
    'spell',
    'subclass',
  ])('treats dnd5e economy fields on nonphysical type %s as not applicable', (type) => {
    const result = normalizeItemEconomy(
      {
        type,
        system: { price: { value: 99, denomination: 'gp' }, rarities: ['rare'] },
      },
      dndIdentity,
    );
    expect(result.price).toEqual({ status: 'not-applicable', currencies: [], per: null });
    expect(result.rarity).toEqual({ status: 'not-applicable', values: [] });
  });

  it('keeps missing dnd5e fields distinct from malformed fields', () => {
    const missing = normalizeItemEconomy({ type: 'weapon', system: {} }, dndIdentity);
    const malformed = normalizeItemEconomy(
      {
        type: 'weapon',
        system: { price: { value: -1, denomination: 'credits' }, rarities: ['Common'] },
      },
      dndIdentity,
    );

    expect(missing.price.status).toBe('missing');
    expect(missing.rarity.status).toBe('missing');
    expect(malformed.price.status).toBe('invalid');
    expect(malformed.rarity.status).toBe('invalid');
  });

  it.each([
    { price: 'ten' },
    { price: { value: true, denomination: 'gp' } },
    { price: { value: 2, denomination: null } },
    { price: { value: Number.POSITIVE_INFINITY, denomination: 'gp' } },
  ])('marks malformed dnd5e price candidate invalid: %#', (system) => {
    expect(normalizeItemEconomy({ type: 'weapon', system }, dndIdentity).price.status).toBe(
      'invalid',
    );
  });

  it.each([
    { rarities: 'common' },
    { rarities: [null] },
    { rarities: ['common', 'common'] },
  ])('handles bounded dnd5e rarity source: %#', (system) => {
    const rarity = normalizeItemEconomy({ type: 'weapon', system }, dndIdentity).rarity;
    if (Array.isArray(system.rarities) && system.rarities.every((value) => value === 'common')) {
      expect(rarity).toEqual({ status: 'known', values: ['common'] });
    } else {
      expect(rarity.status).toBe('invalid');
    }
  });

  it('normalizes the synthetic pf2e fixture with exact coin values and per', () => {
    const result = normalizeItemEconomy(fixture('pf2e-7.8.0.synthetic.json'), pf2eIdentity);

    expect(result.source).toEqual({
      price: { value: { cp: 0, sp: 2, gp: 3, pp: 0 }, per: 2 },
      traits: { rarity: 'uncommon' },
    });
    expect(result.price).toEqual({
      status: 'known',
      currencies: [
        { denomination: 'cp', value: 0 },
        { denomination: 'sp', value: 2 },
        { denomination: 'gp', value: 3 },
        { denomination: 'pp', value: 0 },
      ],
      per: 2,
    });
    expect(result.rarity).toEqual({ status: 'known', values: ['uncommon'] });
  });

  it.each([
    'ammo',
    'armor',
    'backpack',
    'book',
    'consumable',
    'equipment',
    'shield',
    'treasure',
    'weapon',
  ])('treats absent economy fields on pf2e physical type %s as missing', (type) => {
    const result = normalizeItemEconomy({ type, system: {} }, pf2eIdentity);
    expect(result.price.status).toBe('missing');
    expect(result.rarity.status).toBe('missing');
  });

  it.each(['feat', 'spell'])('normalizes rarity but not price for pf2e %s items', (type) => {
    const result = normalizeItemEconomy(
      { type, system: { price: { value: { gp: 99 } }, traits: { rarity: 'rare' } } },
      pf2eIdentity,
    );
    expect(result.price.status).toBe('not-applicable');
    expect(result.rarity).toEqual({ status: 'known', values: ['rare'] });
  });

  it('uses an actual traits.rarity candidate for an otherwise undeclared pf2e type', () => {
    const withRarity = normalizeItemEconomy(
      { type: 'action', system: { traits: { rarity: 'unique' } } },
      pf2eIdentity,
    );
    const absent = normalizeItemEconomy({ type: 'condition', system: {} }, pf2eIdentity);

    expect(withRarity.price.status).toBe('not-applicable');
    expect(withRarity.rarity).toEqual({ status: 'known', values: ['unique'] });
    expect(absent.rarity.status).toBe('not-applicable');
  });

  it.each([
    { price: { value: {} } },
    { price: { value: { credits: 4 } } },
    { price: { value: { gp: -1 } } },
    { price: { value: { gp: 1.5 } } },
    { price: { value: { gp: 1 }, per: 0 } },
    { price: { value: { gp: 1 }, per: 1.5 } },
    { price: { value: '1 gp' } },
  ])('marks malformed pf2e physical price invalid: %#', (system) => {
    const result = normalizeItemEconomy({ type: 'equipment', system }, pf2eIdentity);
    expect(result.price.status).toBe('invalid');
    if ('price' in system && typeof system.price === 'object' && system.price !== null) {
      const value = (system.price as { value?: unknown }).value;
      if (typeof value === 'object' && value !== null && 'credits' in value) {
        expect(result.source.price).toEqual({ value: {} });
      }
    }
  });

  it.each([
    { traits: { rarity: 'Rare' } },
    { traits: { rarity: ['rare'] } },
    { traits: 'rare' },
  ])('marks malformed pf2e rarity invalid: %#', (system) => {
    expect(normalizeItemEconomy({ type: 'spell', system }, pf2eIdentity).rarity.status).toBe(
      'invalid',
    );
  });

  it('reports unsupported systems and versions while retaining only safe candidates', () => {
    const system = {
      price: { value: 4, denomination: 'credits', secret: 'drop' },
      rarity: 'alpha',
      rarities: ['beta'],
      traits: { rarity: 'gamma', value: ['drop'] },
      secret: 'drop',
    };
    const unknown = normalizeItemEconomy({ type: 'thing', system }, { id: 'custom', version: '1' });
    const wrongVersion = normalizeItemEconomy(
      { type: 'thing', system },
      {
        id: 'dnd5e',
        version: '6.0.5',
      },
    );

    expect(unknown.adapter).toMatchObject({ adapterId: null, status: 'unsupported-system' });
    expect(wrongVersion.adapter).toMatchObject({ adapterId: null, status: 'unsupported-version' });
    expect(unknown.source).toEqual({
      price: { value: 4, denomination: 'credits' },
      rarity: 'alpha',
      rarities: ['beta'],
      traits: { rarity: 'gamma' },
    });
    expect(unknown.price.status).toBe('unsupported');
    expect(unknown.rarity.status).toBe('unsupported');
  });

  it.each([
    undefined,
    null,
    [],
    new Date(),
    { rarities: ['x'.repeat(ITEM_ECONOMY_TEXT_MAX_LENGTH + 1)] },
    { rarities: Array(ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH + 1).fill('common') },
  ])('fails closed when the source projection is unavailable: %#', (system) => {
    const result = normalizeItemEconomy({ type: 'weapon', system }, dndIdentity);
    expect(result.adapter.status).toBe('source-unavailable');
    expect(result.source).toEqual({});
    expect(result.price.status).toBe('invalid');
    expect(result.rarity.status).toBe('invalid');
  });

  it('fails closed for cyclic candidates, accessors, and unsafe own keys', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const accessor = Object.defineProperty({}, 'price', { get: () => ({ value: 1 }) });
    const unsafe = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unsafe, '__proto__', { value: 'unsafe', enumerable: true });

    for (const system of [{ rarities: cyclic }, accessor, unsafe]) {
      const result = normalizeItemEconomy({ type: 'weapon', system }, dndIdentity);
      expect(result.adapter.status).toBe('source-unavailable');
      expect(JSON.stringify(result)).not.toContain('unsafe');
    }
  });

  it('fails closed for unsafe, cyclic, accessor, and oversized nested price candidates', () => {
    const cyclicCoin: Record<string, unknown> = {};
    cyclicCoin.gp = cyclicCoin;
    const unsafePrice = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unsafePrice, 'constructor', { value: 1, enumerable: true });
    const accessorPrice = Object.defineProperty({}, 'value', { get: () => 1 });

    for (const price of [
      { value: cyclicCoin },
      unsafePrice,
      accessorPrice,
      { value: { gp: Number.MAX_SAFE_INTEGER + 1 } },
    ]) {
      const result = normalizeItemEconomy({ type: 'equipment', system: { price } }, pf2eIdentity);
      expect(result.adapter.status).toBe('source-unavailable');
      expect(result.source).toEqual({});
    }
  });

  it('fails closed for self-cyclic and unsafe nested coin maps', () => {
    const selfCyclicPrice: Record<string, unknown> = {};
    selfCyclicPrice.value = selfCyclicPrice;
    const unsafeCoin = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unsafeCoin, 'constructor', { value: 1, enumerable: true });

    for (const price of [selfCyclicPrice, { value: unsafeCoin }]) {
      const result = normalizeItemEconomy({ type: 'equipment', system: { price } }, pf2eIdentity);
      expect(result.adapter.status).toBe('source-unavailable');
      expect(result.source).toEqual({});
    }
  });

  it.each([
    { value: { gp: Symbol('coin') } },
    { value: { gp: null } },
    { value: { gp: [1] } },
  ])('marks a bounded but unrepresentable nested coin invalid: %#', (price) => {
    const result = normalizeItemEconomy({ type: 'equipment', system: { price } }, pf2eIdentity);
    expect(result.adapter.status).toBe('supported');
    expect(result.price.status).toBe('invalid');
  });

  it('marks bounded but unrepresentable candidates invalid without discarding other source fields', () => {
    const invalidPrice = normalizeItemEconomy(
      { type: 'weapon', system: { price: Symbol('price'), rarities: ['rare'] } },
      dndIdentity,
    );
    const invalidRarities = normalizeItemEconomy(
      {
        type: 'weapon',
        system: { price: { value: 2, denomination: 'gp' }, rarities: [{}] },
      },
      dndIdentity,
    );
    const invalidTrait = normalizeItemEconomy(
      { type: 'spell', system: { traits: { rarity: Symbol('rarity') } } },
      pf2eIdentity,
    );
    const invalidPf2ePrice = normalizeItemEconomy(
      { type: 'weapon', system: { price: Symbol('price'), traits: { rarity: 'rare' } } },
      pf2eIdentity,
    );

    expect(invalidPrice.source).toEqual({ rarities: ['rare'] });
    expect(invalidPrice.price.status).toBe('invalid');
    expect(invalidPrice.rarity.status).toBe('known');
    expect(invalidRarities.source).toEqual({ price: { value: 2, denomination: 'gp' } });
    expect(invalidRarities.price.status).toBe('known');
    expect(invalidRarities.rarity.status).toBe('invalid');
    expect(invalidTrait.source).toEqual({ traits: {} });
    expect(invalidTrait.rarity.status).toBe('invalid');
    expect(invalidPf2ePrice.source).toEqual({ traits: { rarity: 'rare' } });
    expect(invalidPf2ePrice.price.status).toBe('invalid');
    expect(invalidPf2ePrice.rarity.status).toBe('known');
  });

  it('preserves explicit null candidates and empty nested projections for truthful invalid states', () => {
    const dnd = normalizeItemEconomy(
      { type: 'weapon', system: { price: {}, rarity: null, rarities: null } },
      dndIdentity,
    );
    const pf2eEmptyTraits = normalizeItemEconomy(
      { type: 'spell', system: { traits: {} } },
      pf2eIdentity,
    );
    const pf2eNullTraits = normalizeItemEconomy(
      { type: 'spell', system: { traits: null } },
      pf2eIdentity,
    );

    expect(dnd.source).toEqual({ price: {}, rarity: null, rarities: null });
    expect(dnd.price.status).toBe('invalid');
    expect(dnd.rarity.status).toBe('invalid');
    expect(pf2eEmptyTraits.source).toEqual({ traits: {} });
    expect(pf2eEmptyTraits.rarity.status).toBe('missing');
    expect(pf2eNullTraits.source).toEqual({});
    expect(pf2eNullTraits.rarity.status).toBe('invalid');
  });

  it('fails closed when the total safe projection exceeds its byte budget', () => {
    const long = 'x'.repeat(ITEM_ECONOMY_TEXT_MAX_LENGTH);
    const result = normalizeItemEconomy(
      {
        type: 'weapon',
        system: {
          rarity: Array(ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH).fill(long),
          rarities: Array(ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH).fill(long),
        },
      },
      dndIdentity,
    );
    expect(result.adapter.status).toBe('source-unavailable');
  });

  it('emits an object accepted by the strict economy schema', () => {
    const value = normalizeItemEconomy({ type: 'weapon', system: {} }, dndIdentity);
    expect(itemEconomySchema.parse(value)).toEqual(value);
    expect(itemEconomySchema.safeParse({ ...value, extra: true }).success).toBe(false);
    expect(itemEconomySchema.safeParse({ ...value, source: { secret: true } }).success).toBe(false);
  });

  it('normalizes a pf2e price without an explicit per as a single unit', () => {
    const result = normalizeItemEconomy(
      { type: 'equipment', system: { price: { value: { gp: 1 } } } },
      pf2eIdentity,
    );
    expect(result.price).toEqual({
      status: 'known',
      currencies: [{ denomination: 'gp', value: 1 }],
      per: null,
    });
  });

  it.each([
    [{ id: 42 as unknown as string }, 'invalid_type'],
    [{ id: 'x'.repeat(129) }, 'too_big'],
    [{ id: 'custom' }, 'unsupported-system'],
    [{ id: 'custom', version: null as unknown as string }, 'unsupported-system'],
    [{ id: 'custom', version: 42 as unknown as string }, 'unsupported-system'],
    [{ id: 'custom', version: '' }, 'unsupported-system'],
    [{ id: 'custom', version: 'x'.repeat(129) }, 'unsupported-system'],
  ])('bounds malformed identity metadata %#', (identity, expected) => {
    if (expected === 'invalid_type' || expected === 'too_big') {
      expect(() => normalizeItemEconomy({ type: 'thing', system: {} }, identity)).toThrow();
    } else {
      const result = normalizeItemEconomy({ type: 'thing', system: {} }, identity);
      expect(result.adapter.status).toBe(expected);
      expect(result.adapter.systemVersion).toBeNull();
    }
  });
});

describe('rarity filters', () => {
  it.each([undefined, '', '   '])('treats %p as no filter', (filter) => {
    expect(() => assertItemRarityFilter({ id: 'unknown' }, filter)).not.toThrow();
    const economy = normalizeItemEconomy(
      { type: 'weapon', system: { rarities: ['rare'] } },
      dndIdentity,
    );
    expect(itemMatchesRarity(economy, filter)).toBe(true);
  });

  it('validates and matches canonical keys case-insensitively', () => {
    const dnd = normalizeItemEconomy(
      { type: 'weapon', system: { rarities: ['veryRare'] } },
      dndIdentity,
    );
    const pf2e = normalizeItemEconomy(
      { type: 'spell', system: { traits: { rarity: 'unique' } } },
      pf2eIdentity,
    );

    expect(() => assertItemRarityFilter(dndIdentity, ' VERYRARE ')).not.toThrow();
    expect(itemMatchesRarity(dnd, 'veryrare')).toBe(true);
    expect(itemMatchesRarity(dnd, 'rare')).toBe(false);
    expect(itemMatchesRarity(pf2e, 'UNIQUE')).toBe(true);
  });

  it.each([
    [{ id: 'dnd5e', version: '6.0.6' }, 'Very Rare'],
    [{ id: 'dnd5e', version: '6.0.6' }, 'mythic'],
    [{ id: 'pf2e', version: '7.8.0' }, 'Legendary'],
    [{ id: 'pf2e', version: '7.7.0' }, 'rare'],
    [{ id: 'unknown', version: '1' }, 'rare'],
  ])('rejects unsupported or localized filter %#', (identity, filter) => {
    expectInvalidParams(() => assertItemRarityFilter(identity, filter));
  });

  it('does not match a known filter against missing or not-applicable rarity', () => {
    const missing = normalizeItemEconomy({ type: 'weapon', system: {} }, dndIdentity);
    const notApplicable = normalizeItemEconomy({ type: 'spell', system: {} }, dndIdentity);
    expect(itemMatchesRarity(missing, 'common')).toBe(false);
    expect(itemMatchesRarity(notApplicable, 'common')).toBe(false);
  });

  it('rejects filtering when the item rarity source is invalid or unavailable', () => {
    const invalid = normalizeItemEconomy(
      { type: 'weapon', system: { rarities: ['Common'] } },
      dndIdentity,
    );
    const unavailable = normalizeItemEconomy({ type: 'weapon', system: null }, dndIdentity);
    expectInvalidParams(() => itemMatchesRarity(invalid, 'common'));
    expectInvalidParams(() => itemMatchesRarity(unavailable, 'common'));
  });

  it('rejects a filter when strict adapter metadata omits its system version', () => {
    const economy = itemEconomySchema.parse({
      schemaVersion: ITEM_ECONOMY_SCHEMA_VERSION,
      adapter: {
        systemId: 'dnd5e',
        systemVersion: null,
        adapterId: null,
        status: 'unsupported-version',
      },
      source: {},
      price: { status: 'unsupported', currencies: [], per: null },
      rarity: { status: 'unsupported', values: [] },
    });
    expectInvalidParams(() => itemMatchesRarity(economy, 'common'));
  });
});

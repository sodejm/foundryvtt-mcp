import { describe, expect, it } from 'vitest';
import { type ItemEconomy, itemEconomySchema } from './item-economy-contract.js';
import {
  itemEconomyAliases,
  itemEconomyText,
  publicItemEconomy,
  restItemSystemIdentity,
} from './item-economy-read.js';

function economy(
  overrides: { price?: ItemEconomy['price']; rarity?: ItemEconomy['rarity'] } = {},
): ItemEconomy {
  return itemEconomySchema.parse({
    schemaVersion: 1,
    adapter: {
      systemId: 'dnd5e',
      systemVersion: '6.0.6',
      adapterId: 'dnd5e@6.0.6',
      status: 'supported',
    },
    source: {},
    price: overrides.price ?? {
      status: 'known',
      currencies: [{ value: 5, denomination: 'gp' }],
      per: null,
    },
    rarity: overrides.rarity ?? { status: 'known', values: ['rare'] },
  });
}

describe('restItemSystemIdentity', () => {
  it('projects flat REST identity with and without a version', () => {
    expect(restItemSystemIdentity({ system: 'dnd5e', systemVersion: '6.0.6' })).toEqual({
      id: 'dnd5e',
      version: '6.0.6',
    });
    expect(restItemSystemIdentity({ system: 'custom' })).toEqual({ id: 'custom' });
  });

  it('projects nested REST identity with and without a version', () => {
    expect(restItemSystemIdentity({ system: { id: 'pf2e', version: '7.8.0' } })).toEqual({
      id: 'pf2e',
      version: '7.8.0',
    });
    expect(restItemSystemIdentity({ system: { id: 'custom' } })).toEqual({ id: 'custom' });
  });

  it.each([
    undefined,
    null,
    {},
    { system: '' },
    { system: 'dnd5e', systemVersion: '' },
    { system: { id: '' } },
    { system: { id: 'pf2e', version: '' } },
    { system: 7 },
  ])('rejects malformed REST identity %#', (value) => {
    expect(() => restItemSystemIdentity(value)).toThrow();
  });
});

describe('itemEconomyAliases', () => {
  it('emits lossless single-currency and single-rarity aliases', () => {
    expect(itemEconomyAliases(economy())).toEqual({
      price: { value: 5, denomination: 'gp' },
      rarity: 'rare',
    });
    expect(
      itemEconomyAliases(
        economy({
          price: {
            status: 'known',
            currencies: [{ value: 2, denomination: 'sp' }],
            per: 1,
          },
        }),
      ),
    ).toEqual({ price: { value: 2, denomination: 'sp' }, rarity: 'rare' });
  });

  it('omits ambiguous multi-currency and per-unit aliases', () => {
    expect(
      itemEconomyAliases(
        economy({
          price: {
            status: 'known',
            currencies: [
              { value: 1, denomination: 'gp' },
              { value: 2, denomination: 'sp' },
            ],
            per: null,
          },
        }),
      ),
    ).toEqual({ rarity: 'rare' });
    expect(
      itemEconomyAliases(
        economy({
          price: {
            status: 'known',
            currencies: [{ value: 1, denomination: 'gp' }],
            per: 10,
          },
        }),
      ),
    ).toEqual({ rarity: 'rare' });
  });

  it('omits aliases for known empty or unknown values', () => {
    expect(
      itemEconomyAliases(
        economy({
          price: { status: 'missing', currencies: [], per: null },
          rarity: { status: 'known', values: [] },
        }),
      ),
    ).toEqual({});
    expect(
      itemEconomyAliases(
        economy({
          price: { status: 'known', currencies: [], per: null },
          rarity: { status: 'unsupported', values: [] },
        }),
      ),
    ).toEqual({});
  });
});

describe('publicItemEconomy', () => {
  it('uses a validated economy and preserves unrelated public fields', () => {
    const normalized = economy();
    expect(
      publicItemEconomy({
        id: 'item-1',
        type: 'weapon',
        name: 'Example',
        economy: normalized,
      }),
    ).toEqual({
      id: 'item-1',
      type: 'weapon',
      name: 'Example',
      economy: normalized,
      price: { value: 5, denomination: 'gp' },
      rarity: 'rare',
    });
  });

  it('ignores flat legacy price and rarity while deriving unknown-system economy', () => {
    const projected = publicItemEconomy({
      id: 'item-2',
      type: 'weapon',
      price: { value: 999, denomination: 'gp' },
      rarity: 'legendary',
      system: { price: { value: 1, denomination: 'sp' }, rarities: ['rare'] },
    });

    expect(projected).not.toHaveProperty('price');
    expect(projected).not.toHaveProperty('rarity');
    expect(projected.economy).toMatchObject({
      adapter: { systemId: 'unknown', status: 'unsupported-system' },
      price: { status: 'unsupported' },
      rarity: { status: 'unsupported' },
    });
  });

  it('rejects malformed supplied normalized economy', () => {
    expect(() =>
      publicItemEconomy({
        type: 'weapon',
        economy: { schemaVersion: 1, price: { status: 'known' } },
      }),
    ).toThrow();
  });
});

describe('itemEconomyText', () => {
  it('renders known values, multiple currencies, per units, and known empty rarity', () => {
    expect(itemEconomyText(economy())).toEqual({ price: '5 gp', rarity: 'rare' });
    expect(
      itemEconomyText(
        economy({
          price: {
            status: 'known',
            currencies: [
              { value: 1, denomination: 'gp' },
              { value: 3, denomination: 'sp' },
            ],
            per: 5,
          },
          rarity: { status: 'known', values: [] },
        }),
      ),
    ).toEqual({ price: '1 gp + 3 sp per 5', rarity: 'No rarity' });
    expect(
      itemEconomyText(
        economy({
          price: {
            status: 'known',
            currencies: [{ value: 4, denomination: 'cp' }],
            per: 1,
          },
          rarity: { status: 'known', values: ['common', 'uncommon'] },
        }),
      ),
    ).toEqual({ price: '4 cp', rarity: 'common, uncommon' });
  });

  it.each([
    'missing',
    'invalid',
    'not-applicable',
    'unsupported',
  ] as const)('renders explicit unknown status %s', (status) => {
    expect(
      itemEconomyText(
        economy({
          price: { status, currencies: [], per: null },
          rarity: { status, values: [] },
        }),
      ),
    ).toEqual({
      price: `Unknown price (${status})`,
      rarity: `Unknown rarity (${status})`,
    });
  });
});

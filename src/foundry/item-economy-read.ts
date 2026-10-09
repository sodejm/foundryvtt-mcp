/** Shared public projection and display of versioned item economy values. */
import { z } from 'zod';
import { type ItemEconomy, itemEconomySchema } from './item-economy-contract.js';
import { type ItemEconomyIdentity, normalizeItemEconomy } from './item-normalization.js';

const identitySchema = z.union([
  z.object({
    system: z.string().min(1).max(128),
    systemVersion: z.string().min(1).max(128).optional(),
  }),
  z.object({
    system: z.object({
      id: z.string().min(1).max(128),
      version: z.string().min(1).max(128).optional(),
    }),
  }),
]);
export function restItemSystemIdentity(value: unknown): ItemEconomyIdentity {
  const result = identitySchema.parse(value);
  return typeof result.system === 'string'
    ? {
        id: result.system,
        ...('systemVersion' in result && result.systemVersion !== undefined
          ? { version: result.systemVersion }
          : {}),
      }
    : result.system;
}

/** Compatibility aliases exist only for lossless, unambiguous normalized values. */
export function itemEconomyAliases(economy: ItemEconomy): {
  price?: { value: number; denomination: string };
  rarity?: string;
} {
  const price = economy.price;
  const rarity = economy.rarity;
  return {
    ...(price.status === 'known' &&
    price.currencies.length === 1 &&
    (price.per === null || price.per === 1)
      ? { price: price.currencies[0] }
      : {}),
    ...(rarity.status === 'known' && rarity.values.length === 1
      ? { rarity: rarity.values[0] }
      : {}),
  };
}
export function publicItemEconomy(value: unknown): Record<string, unknown> {
  const item = z
    .object({ type: z.string(), economy: itemEconomySchema.optional() })
    .passthrough()
    .parse(value);
  const { price: _price, rarity: _rarity, ...rest } = item;
  const economy = item.economy ?? normalizeItemEconomy(item, { id: 'unknown' });
  return { ...rest, economy, ...itemEconomyAliases(economy) };
}
export function itemEconomyText(economy: ItemEconomy): { price: string; rarity: string } {
  return {
    price:
      economy.price.status === 'known'
        ? `${economy.price.currencies.map(({ value, denomination }) => `${value} ${denomination}`).join(' + ')}${economy.price.per === null || economy.price.per === 1 ? '' : ` per ${economy.price.per}`}`
        : `Unknown price (${economy.price.status})`,
    rarity:
      economy.rarity.status === 'known'
        ? economy.rarity.values.join(', ') || 'No rarity'
        : `Unknown rarity (${economy.rarity.status})`,
  };
}

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  ITEM_ECONOMY_SCHEMA_VERSION,
  ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH,
  ITEM_ECONOMY_SOURCE_MAX_BYTES,
  ITEM_ECONOMY_TEXT_MAX_LENGTH,
  type ItemEconomy,
  type ItemEconomySource,
  itemEconomySchema,
} from './item-economy-contract.js';

export interface ItemEconomyIdentity {
  id: string;
  version?: string | undefined;
}

export interface ItemEconomyInput {
  type: string;
  system?: unknown;
}

type AdapterId = NonNullable<ItemEconomy['adapter']['adapterId']>;
type SafeScalar = null | boolean | number | string;
type CandidateKey = 'price' | 'rarity' | 'rarities' | 'traits.rarity';

interface SourceProjection {
  source: ItemEconomySource;
  available: boolean;
  invalid: ReadonlySet<CandidateKey>;
}

const DND5E_VERSION = '6.0.6';
const PF2E_VERSION = '7.8.0';

const DND5E_RARITIES = [
  'artifact',
  'common',
  'legendary',
  'mundane',
  'rare',
  'uncommon',
  'varies',
  'veryRare',
] as const;
const PF2E_RARITIES = ['common', 'uncommon', 'rare', 'unique'] as const;
const DND5E_DENOMINATIONS = new Set(['cp', 'sp', 'ep', 'gp', 'pp']);
const DND5E_PHYSICAL_TYPES = new Set([
  'consumable',
  'container',
  'equipment',
  'loot',
  'tool',
  'weapon',
]);
const PF2E_DENOMINATIONS = ['cp', 'sp', 'gp', 'pp'] as const;
const PF2E_PHYSICAL_TYPES = new Set([
  'ammo',
  'armor',
  'backpack',
  'book',
  'consumable',
  'equipment',
  'shield',
  'treasure',
  'weapon',
]);
// Pinned PF2e spell and feat schemas also implement TraitsWithRarity. Other
// item types remain conservative unless they actually expose traits.rarity.
const PF2E_DECLARED_RARITY_TYPES = new Set([...PF2E_PHYSICAL_TYPES, 'feat', 'spell']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const unsupportedPrice = (): ItemEconomy['price'] => ({
  status: 'unsupported',
  currencies: [],
  per: null,
});
const unsupportedRarity = (): ItemEconomy['rarity'] => ({
  status: 'unsupported',
  values: [],
});
const invalidPrice = (): ItemEconomy['price'] => ({
  status: 'invalid',
  currencies: [],
  per: null,
});
const invalidRarity = (): ItemEconomy['rarity'] => ({
  status: 'invalid',
  values: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor?.value;
}

function hasDataValue(record: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return Boolean(descriptor && 'value' in descriptor);
}

function assertDataProperties(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && !('value' in descriptor)) {
      throw new Error('accessor source candidate');
    }
  }
}

function hasUnsafeKey(record: Record<string, unknown>): boolean {
  return Object.getOwnPropertyNames(record).some((key) => UNSAFE_KEYS.has(key));
}

function projectScalar(value: unknown): SafeScalar | undefined {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string' && value.length <= ITEM_ECONOMY_TEXT_MAX_LENGTH) {
    return value;
  }
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  ) {
    return value;
  }
  return undefined;
}

function projectValue(
  value: unknown,
  seen: WeakSet<object>,
): SafeScalar | SafeScalar[] | undefined {
  if (
    (typeof value === 'string' && value.length > ITEM_ECONOMY_TEXT_MAX_LENGTH) ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('oversized source candidate');
  }
  const scalar = projectScalar(value);
  if (scalar !== undefined || value === null) {
    return scalar;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.length > ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH) {
    throw new Error('oversized source candidate');
  }
  seen.add(value);
  const projected: SafeScalar[] = [];
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null && seen.has(entry)) {
      throw new Error('cyclic source candidate');
    }
    if (typeof entry === 'string' && entry.length > ITEM_ECONOMY_TEXT_MAX_LENGTH) {
      throw new Error('oversized source candidate');
    }
    const item = projectScalar(entry);
    if (item === undefined && entry !== null) {
      return undefined;
    }
    projected.push(item as SafeScalar);
  }
  seen.delete(value);
  return projected;
}

function projectCoinValue(
  value: unknown,
  seen: WeakSet<object>,
): Record<string, SafeScalar> | SafeScalar | SafeScalar[] | undefined {
  if (!isRecord(value)) {
    return projectValue(value, seen);
  }
  if (seen.has(value)) {
    throw new Error('cyclic source candidate');
  }
  if (hasUnsafeKey(value)) {
    throw new Error('unsafe source candidate');
  }
  assertDataProperties(value, PF2E_DENOMINATIONS);
  seen.add(value);
  const projected: Record<string, SafeScalar> = {};
  for (const denomination of PF2E_DENOMINATIONS) {
    if (!hasDataValue(value, denomination)) {
      continue;
    }
    const candidate = dataValue(value, denomination);
    if (typeof candidate === 'object' && candidate !== null && seen.has(candidate)) {
      throw new Error('cyclic source candidate');
    }
    const scalar = projectValue(candidate, seen);
    if (scalar === undefined && candidate !== null) {
      seen.delete(value);
      return undefined;
    }
    if (Array.isArray(scalar)) {
      seen.delete(value);
      return undefined;
    }
    projected[denomination] = scalar as SafeScalar;
  }
  seen.delete(value);
  return projected;
}

function projectPrice(
  value: unknown,
  seen: WeakSet<object>,
): ItemEconomySource['price'] | undefined {
  if (!isRecord(value)) {
    return projectValue(value, seen);
  }
  if (hasUnsafeKey(value)) {
    throw new Error('unsafe source candidate');
  }
  assertDataProperties(value, ['value', 'denomination', 'per']);
  seen.add(value);
  const projected: Record<string, unknown> = {};
  if (hasDataValue(value, 'value')) {
    projected.value = projectCoinValue(dataValue(value, 'value'), seen);
  }
  for (const key of ['denomination', 'per'] as const) {
    if (!hasDataValue(value, key)) {
      continue;
    }
    projected[key] = projectScalar(dataValue(value, key));
  }
  seen.delete(value);
  return projected as ItemEconomySource['price'];
}

function projectSource(system: unknown): SourceProjection {
  const invalid = new Set<CandidateKey>();
  if (!isRecord(system) || hasUnsafeKey(system)) {
    return { source: {}, available: false, invalid };
  }
  const seen = new WeakSet<object>();
  const source: Record<string, unknown> = {};
  try {
    assertDataProperties(system, ['price', 'rarity', 'rarities', 'traits']);
    if (hasDataValue(system, 'price')) {
      const projected = projectPrice(dataValue(system, 'price'), seen);
      if (projected === undefined) {
        invalid.add('price');
      } else {
        source.price = projected;
      }
    }
    for (const key of ['rarity', 'rarities'] as const) {
      if (!hasDataValue(system, key)) {
        continue;
      }
      const projected = projectValue(dataValue(system, key), seen);
      if (projected === undefined && dataValue(system, key) !== null) {
        invalid.add(key);
      } else {
        source[key] = projected;
      }
    }
    if (hasDataValue(system, 'traits')) {
      const traits = dataValue(system, 'traits');
      if (isRecord(traits) && !hasUnsafeKey(traits)) {
        assertDataProperties(traits, ['rarity']);
        const projectedTraits: Record<string, unknown> = {};
        if (hasDataValue(traits, 'rarity')) {
          const projected = projectValue(dataValue(traits, 'rarity'), seen);
          if (projected === undefined && dataValue(traits, 'rarity') !== null) {
            invalid.add('traits.rarity');
          } else {
            projectedTraits.rarity = projected;
          }
        }
        source.traits = projectedTraits;
      } else {
        invalid.add('traits.rarity');
      }
    }
  } catch {
    return { source: {}, available: false, invalid: new Set() };
  }
  const boundedSource = source as ItemEconomySource;
  if (Buffer.byteLength(JSON.stringify(boundedSource), 'utf8') > ITEM_ECONOMY_SOURCE_MAX_BYTES) {
    return { source: {}, available: false, invalid: new Set() };
  }
  return { source: boundedSource, available: true, invalid };
}

function adapterFor(identity: ItemEconomyIdentity): AdapterId | null {
  if (identity.id === 'dnd5e' && identity.version === DND5E_VERSION) {
    return 'dnd5e@6.0.6';
  }
  if (identity.id === 'pf2e' && identity.version === PF2E_VERSION) {
    return 'pf2e@7.8.0';
  }
  return null;
}

function canonicalRarities(adapterId: AdapterId): readonly string[] {
  return adapterId === 'dnd5e@6.0.6' ? DND5E_RARITIES : PF2E_RARITIES;
}

function normalizeDnd5e(
  itemType: string,
  source: ItemEconomySource,
  invalid: ReadonlySet<CandidateKey>,
): Pick<ItemEconomy, 'price' | 'rarity'> {
  const physical = DND5E_PHYSICAL_TYPES.has(itemType);
  let price: ItemEconomy['price'];
  if (!physical) {
    price = { status: 'not-applicable', currencies: [], per: null };
  } else if (invalid.has('price')) {
    price = invalidPrice();
  } else if (!('price' in source)) {
    price = { status: 'missing', currencies: [], per: null };
  } else if (!isRecord(source.price)) {
    price = invalidPrice();
  } else {
    const value = source.price.value;
    const denomination = source.price.denomination;
    price =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      typeof denomination === 'string' &&
      DND5E_DENOMINATIONS.has(denomination)
        ? { status: 'known', currencies: [{ denomination, value }], per: null }
        : invalidPrice();
  }

  let rarity: ItemEconomy['rarity'];
  if (!physical) {
    rarity = { status: 'not-applicable', values: [] };
  } else if (invalid.has('rarities')) {
    rarity = invalidRarity();
  } else if (!('rarities' in source)) {
    rarity = { status: 'missing', values: [] };
  } else if (
    Array.isArray(source.rarities) &&
    source.rarities.every(
      (value): value is string =>
        typeof value === 'string' && (DND5E_RARITIES as readonly string[]).includes(value),
    )
  ) {
    rarity = { status: 'known', values: [...new Set(source.rarities)] };
  } else {
    rarity = invalidRarity();
  }
  return { price, rarity };
}

function normalizePf2e(
  itemType: string,
  source: ItemEconomySource,
  invalid: ReadonlySet<CandidateKey>,
): Pick<ItemEconomy, 'price' | 'rarity'> {
  const physical = PF2E_PHYSICAL_TYPES.has(itemType);
  let price: ItemEconomy['price'];
  if (!physical) {
    price = { status: 'not-applicable', currencies: [], per: null };
  } else if (invalid.has('price')) {
    price = invalidPrice();
  } else if (!('price' in source)) {
    price = { status: 'missing', currencies: [], per: null };
  } else if (!isRecord(source.price) || !isRecord(source.price.value)) {
    price = invalidPrice();
  } else {
    const currencies: ItemEconomy['price']['currencies'] = [];
    let valid = true;
    for (const denomination of PF2E_DENOMINATIONS) {
      if (!(denomination in source.price.value)) {
        continue;
      }
      const value = source.price.value[denomination];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        valid = false;
        break;
      }
      currencies.push({ denomination, value });
    }
    const per = source.price.per;
    if (per !== undefined && (typeof per !== 'number' || !Number.isSafeInteger(per) || per <= 0)) {
      valid = false;
    }
    price =
      valid && currencies.length > 0
        ? { status: 'known', currencies, per: typeof per === 'number' ? per : null }
        : invalidPrice();
  }

  const projectedRarity = isRecord(source.traits) ? source.traits.rarity : undefined;
  let rarity: ItemEconomy['rarity'];
  if (invalid.has('traits.rarity')) {
    rarity = invalidRarity();
  } else if (projectedRarity === undefined) {
    rarity = PF2E_DECLARED_RARITY_TYPES.has(itemType)
      ? { status: 'missing', values: [] }
      : { status: 'not-applicable', values: [] };
  } else if (
    typeof projectedRarity === 'string' &&
    (PF2E_RARITIES as readonly string[]).includes(projectedRarity)
  ) {
    rarity = { status: 'known', values: [projectedRarity] };
  } else {
    rarity = invalidRarity();
  }
  return { price, rarity };
}

export function normalizeItemEconomy(
  item: ItemEconomyInput,
  identity: ItemEconomyIdentity,
): ItemEconomy {
  const systemId = typeof identity.id === 'string' && identity.id.length <= 128 ? identity.id : '';
  const systemVersion =
    typeof identity.version === 'string' &&
    identity.version.length > 0 &&
    identity.version.length <= 128
      ? identity.version
      : null;
  const adapterId = adapterFor({
    id: systemId,
    ...(systemVersion ? { version: systemVersion } : {}),
  });
  const projected = projectSource(item.system);
  const adapterStatus: ItemEconomy['adapter']['status'] = adapterId
    ? projected.available
      ? 'supported'
      : 'source-unavailable'
    : systemId === 'dnd5e' || systemId === 'pf2e'
      ? 'unsupported-version'
      : 'unsupported-system';
  let normalized: Pick<ItemEconomy, 'price' | 'rarity'>;
  if (!adapterId) {
    normalized = { price: unsupportedPrice(), rarity: unsupportedRarity() };
  } else if (!projected.available) {
    normalized = { price: invalidPrice(), rarity: invalidRarity() };
  } else {
    normalized =
      adapterId === 'dnd5e@6.0.6'
        ? normalizeDnd5e(item.type, projected.source, projected.invalid)
        : normalizePf2e(item.type, projected.source, projected.invalid);
  }
  return itemEconomySchema.parse({
    schemaVersion: ITEM_ECONOMY_SCHEMA_VERSION,
    adapter: { systemId, systemVersion, adapterId, status: adapterStatus },
    source: projected.source,
    ...normalized,
  });
}

function invalidRarityFilter(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function normalizedFilter(identity: ItemEconomyIdentity, rarity?: string): string | undefined {
  if (rarity === undefined || rarity.trim() === '') {
    return undefined;
  }
  const adapterId = adapterFor(identity);
  if (!adapterId) {
    invalidRarityFilter('Rarity filtering is unavailable for this system version');
  }
  const match = canonicalRarities(adapterId).find(
    (candidate) =>
      candidate.toLocaleLowerCase('en-US') === rarity.trim().toLocaleLowerCase('en-US'),
  );
  if (!match) {
    invalidRarityFilter(`Unsupported rarity filter for ${adapterId}`);
  }
  return match;
}

export function assertItemRarityFilter(identity: ItemEconomyIdentity, rarity?: string): void {
  normalizedFilter(identity, rarity);
}

export function itemMatchesRarity(economy: ItemEconomy, rarity?: string): boolean {
  if (rarity === undefined || rarity.trim() === '') {
    return true;
  }
  const identity: ItemEconomyIdentity = {
    id: economy.adapter.systemId,
    ...(economy.adapter.systemVersion ? { version: economy.adapter.systemVersion } : {}),
  };
  const filter = normalizedFilter(identity, rarity);
  if (economy.adapter.status === 'source-unavailable' || economy.rarity.status === 'invalid') {
    invalidRarityFilter('Rarity source data is unavailable or invalid');
  }
  return economy.rarity.status === 'known' && economy.rarity.values.includes(filter as string);
}

import type {
  ActorField,
  ActorIdentity,
  ActorItemSummary,
  ActorSectionName,
  ActorSystemIdentity,
} from './actor-sheet-contract.js';
import { type ItemEconomyIdentity, normalizeItemEconomy } from './item-normalization.js';
import type { WorldActor, WorldData, WorldItem } from './types.js';

const MAX_FIELD_TEXT_UNITS = 4096;
const MAX_IDENTITY_TEXT_UNITS = 512;
const MAX_FIELDS = 64;
// Structured-read handlers include the same public object as JSON text and as
// structuredContent. Keep all scalar field strings collectively small enough
// that a maximum-width section cannot cross the 128 KiB MCP response bound.
const MAX_FIELD_VALUE_UNITS = 8192;
const MAX_GENERIC_NODES = 256;
const MAX_GENERIC_DEPTH = 4;
const BLOCKED_PATH_SEGMENTS = new Set([
  'apikey',
  'auth',
  'credential',
  'credentials',
  'flag',
  'flags',
  'ownership',
  'password',
  'permission',
  'permissions',
  'prototypetoken',
  'secret',
  'secrets',
  'token',
]);

interface FieldDefinition {
  key: string;
  label: string;
  paths: string[];
  richText?: boolean;
}

const ABILITY_LABELS: Record<string, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};
const DND_SKILL_LABELS: Record<string, string> = {
  acr: 'Acrobatics',
  ani: 'Animal Handling',
  arc: 'Arcana',
  ath: 'Athletics',
  dec: 'Deception',
  his: 'History',
  ins: 'Insight',
  itm: 'Intimidation',
  inv: 'Investigation',
  med: 'Medicine',
  nat: 'Nature',
  prc: 'Perception',
  prf: 'Performance',
  per: 'Persuasion',
  rel: 'Religion',
  slt: 'Sleight of Hand',
  ste: 'Stealth',
  sur: 'Survival',
};
const PF2E_SKILL_LABELS: Record<string, string> = {
  acrobatics: 'Acrobatics',
  arcana: 'Arcana',
  athletics: 'Athletics',
  crafting: 'Crafting',
  deception: 'Deception',
  diplomacy: 'Diplomacy',
  intimidation: 'Intimidation',
  medicine: 'Medicine',
  nature: 'Nature',
  occultism: 'Occultism',
  performance: 'Performance',
  religion: 'Religion',
  society: 'Society',
  stealth: 'Stealth',
  survival: 'Survival',
  thievery: 'Thievery',
};

function truncateUtf16(value: string, maxUnits: number): { value: string; truncated: boolean } {
  if (value.length <= maxUnits) {
    return { value, truncated: false };
  }
  let end = maxUnits;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return { value: value.slice(0, end), truncated: true };
}

function sanitizeRichText(value: string): string {
  return value.replace(
    /<section\b[^>]*\bclass\s*=\s*(?:"[^"]*\bsecret\b[^"]*"|'[^']*\bsecret\b[^']*'|[^\s>]*\bsecret\b[^\s>]*)[^>]*>[\s\S]*?<\/section\s*>/gi,
    '',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarAt(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function publicScalar(
  value: unknown,
  richText: boolean,
): {
  value?: string | number | boolean | null;
  truncated?: boolean;
} {
  if (value === null || typeof value === 'boolean') {
    return { value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value } : {};
  }
  if (typeof value !== 'string') {
    return {};
  }
  const safe = richText ? sanitizeRichText(value) : value;
  const result = truncateUtf16(safe, MAX_FIELD_TEXT_UNITS);
  return result.truncated ? result : { value: result.value };
}

function fieldFromDefinition(
  system: Record<string, unknown>,
  definition: FieldDefinition,
): ActorField {
  let chosen = definition.paths[0] ?? '';
  let scalar: ReturnType<typeof publicScalar> = {};
  for (const path of definition.paths) {
    const candidate = scalarAt(system, path);
    const projected = publicScalar(candidate, definition.richText === true);
    if (Object.hasOwn(projected, 'value')) {
      chosen = path;
      scalar = projected;
      break;
    }
  }
  const present = Object.hasOwn(scalar, 'value');
  return {
    key: definition.key,
    label: definition.label,
    source: 'normalized',
    path: `system.${chosen}`,
    present,
    ...(present ? { value: scalar.value } : {}),
    ...(scalar.truncated === true ? { truncated: true } : {}),
  };
}

function abilityDefinitions(profile: 'dnd5e' | 'pf2e'): FieldDefinition[] {
  return Object.entries(ABILITY_LABELS).flatMap(([id, label]) => {
    const suffixes = profile === 'dnd5e' ? ['value', 'mod', 'save'] : ['mod'];
    return suffixes.map((suffix) => ({
      key: `ability.${id}.${suffix}`,
      label: `${label} ${suffix === 'value' ? 'Score' : suffix === 'mod' ? 'Modifier' : 'Save'}`,
      paths: [`abilities.${id}.${suffix}`],
    }));
  });
}

function skillDefinitions(profile: 'dnd5e' | 'pf2e'): FieldDefinition[] {
  const labels = profile === 'dnd5e' ? DND_SKILL_LABELS : PF2E_SKILL_LABELS;
  return Object.entries(labels).flatMap(([id, label]) => {
    const suffixes = profile === 'dnd5e' ? ['value', 'mod'] : ['mod'];
    return suffixes.map((suffix) => ({
      key: `skill.${id}.${suffix}`,
      label: `${label} ${suffix === 'value' ? 'Proficiency' : 'Modifier'}`,
      paths: [`skills.${id}.${suffix}`],
    }));
  });
}

function dndDefinitions(section: ActorSectionName, delegated: boolean): FieldDefinition[] {
  switch (section) {
    case 'attributes':
      return [
        { key: 'hp.value', label: 'Hit Points', paths: ['attributes.hp.value'] },
        { key: 'hp.max', label: 'Maximum Hit Points', paths: ['attributes.hp.max'] },
        { key: 'hp.temp', label: 'Temporary Hit Points', paths: ['attributes.hp.temp'] },
        { key: 'ac.value', label: 'Armor Class', paths: ['attributes.ac.value'] },
      ];
    case 'abilities':
      return abilityDefinitions('dnd5e');
    case 'skills':
      return skillDefinitions('dnd5e');
    case 'details':
      return [
        { key: 'level', label: 'Level', paths: ['details.level'] },
        { key: 'challenge', label: 'Challenge Rating', paths: ['details.cr'] },
        { key: 'race', label: 'Race', paths: ['details.race'] },
        {
          key: 'background',
          label: 'Background',
          paths: ['details.background.name', 'details.background.value'],
        },
        { key: 'alignment', label: 'Alignment', paths: ['details.alignment'] },
        ...(delegated
          ? []
          : [
              {
                key: 'biography',
                label: 'Biography',
                paths: ['details.biography.value'],
                richText: true,
              },
            ]),
      ];
    case 'currency':
      return ['pp', 'gp', 'ep', 'sp', 'cp'].map((id) => ({
        key: `currency.${id}`,
        label: id.toUpperCase(),
        paths: [`currency.${id}`],
      }));
    case 'resources':
      return [
        ...['primary', 'secondary', 'tertiary'].flatMap((slot) =>
          ['label', 'value', 'max'].map((property) => ({
            key: `resource.${slot}.${property}`,
            label: `${slot} Resource ${property}`,
            paths: [`resources.${slot}.${property}`],
          })),
        ),
        { key: 'exhaustion', label: 'Exhaustion', paths: ['attributes.exhaustion'] },
      ];
    case 'system':
      return [];
  }
}

function pf2eDefinitions(section: ActorSectionName, delegated: boolean): FieldDefinition[] {
  switch (section) {
    case 'attributes':
      return [
        { key: 'hp.value', label: 'Hit Points', paths: ['attributes.hp.value'] },
        { key: 'hp.max', label: 'Maximum Hit Points', paths: ['attributes.hp.max'] },
        { key: 'hp.temp', label: 'Temporary Hit Points', paths: ['attributes.hp.temp'] },
        { key: 'ac.value', label: 'Armor Class', paths: ['attributes.ac.value'] },
      ];
    case 'abilities':
      return abilityDefinitions('pf2e');
    case 'skills':
      return skillDefinitions('pf2e');
    case 'details':
      return [
        { key: 'level', label: 'Level', paths: ['details.level.value'] },
        { key: 'ancestry', label: 'Ancestry', paths: ['details.ancestry.name'] },
        { key: 'heritage', label: 'Heritage', paths: ['details.heritage.name'] },
        { key: 'class', label: 'Class', paths: ['details.class.name'] },
        { key: 'background', label: 'Background', paths: ['details.background.name'] },
        { key: 'alignment', label: 'Alignment', paths: ['details.alignment.value'] },
        ...(delegated
          ? []
          : [
              {
                key: 'biography',
                label: 'Biography',
                paths: ['details.biography.value'],
                richText: true,
              },
            ]),
      ];
    case 'currency':
      return ['pp', 'gp', 'sp', 'cp'].map((id) => ({
        key: `currency.${id}`,
        label: id.toUpperCase(),
        paths: [`currency.${id}`],
      }));
    case 'resources':
      return [
        { key: 'heroPoints.value', label: 'Hero Points', paths: ['resources.heroPoints.value'] },
        {
          key: 'heroPoints.max',
          label: 'Maximum Hero Points',
          paths: ['resources.heroPoints.max'],
        },
        { key: 'dying.value', label: 'Dying', paths: ['attributes.dying.value'] },
        { key: 'wounded.value', label: 'Wounded', paths: ['attributes.wounded.value'] },
        { key: 'doomed.value', label: 'Doomed', paths: ['attributes.doomed.value'] },
      ];
    case 'system':
      return [];
  }
}

function hasBlockedSegment(path: string[]): boolean {
  return path.some((segment) => {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      BLOCKED_PATH_SEGMENTS.has(normalized) ||
      ['apikey', 'credential', 'password', 'secret', 'ownership', 'prototypetoken'].some((marker) =>
        normalized.includes(marker),
      )
    );
  });
}

function genericFields(system: Record<string, unknown>): ActorField[] {
  const fields: ActorField[] = [];
  let visited = 0;
  const walk = (value: unknown, path: string[], depth: number): void => {
    if (fields.length >= MAX_FIELDS || visited >= MAX_GENERIC_NODES || depth > MAX_GENERIC_DEPTH) {
      return;
    }
    visited += 1;
    if (hasBlockedSegment(path)) {
      return;
    }
    const scalar = publicScalar(value, false);
    if (Object.hasOwn(scalar, 'value')) {
      const joined = path.join('.');
      const key = truncateUtf16(joined, 128).value || 'value';
      fields.push({
        key,
        label: truncateUtf16(joined, 256).value || 'Value',
        source: 'system-path',
        path: truncateUtf16(`system.${joined}`, 512).value,
        present: true,
        value: scalar.value,
        ...(scalar.truncated === true ? { truncated: true } : {}),
      });
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const key of Object.keys(value).sort()) {
      walk(value[key], [...path, key], depth + 1);
      if (fields.length >= MAX_FIELDS || visited >= MAX_GENERIC_NODES) {
        return;
      }
    }
  };
  for (const key of Object.keys(system).sort()) {
    walk(system[key], [key], 1);
    if (fields.length >= MAX_FIELDS || visited >= MAX_GENERIC_NODES) {
      break;
    }
  }
  return fields;
}

function boundFieldValues(fields: ActorField[]): ActorField[] {
  let remaining = MAX_FIELD_VALUE_UNITS;
  return fields.map((field) => {
    if (typeof field.value !== 'string') {
      return field;
    }
    const bounded = truncateUtf16(field.value, Math.max(remaining, 0));
    remaining -= bounded.value.length;
    return {
      ...field,
      value: bounded.value,
      ...(field.truncated === true || bounded.truncated ? { truncated: true } : {}),
    };
  });
}

export function actorSystemIdentity(world: WorldData): ActorSystemIdentity {
  const id =
    typeof world.system.id === 'string' ? world.system.id.toLowerCase() || 'unknown' : 'unknown';
  const version = typeof world.system.version === 'string' ? world.system.version : undefined;
  const profile = id === 'dnd5e' ? 'dnd5e' : id === 'pf2e' ? 'pf2e' : 'generic';
  return {
    id: truncateUtf16(id, 128).value,
    ...(version === undefined ? {} : { version: truncateUtf16(version, 128).value }),
    profile,
  };
}

export function publicActorIdentity(actor: WorldActor): ActorIdentity {
  return {
    id: actor._id,
    uuid: `Actor.${actor._id}`,
    name: truncateUtf16(actor.name, MAX_IDENTITY_TEXT_UNITS).value,
    type: truncateUtf16(actor.type, 128).value,
    ...(typeof actor.img === 'string' ? { img: truncateUtf16(actor.img, 2048).value } : {}),
  };
}

export function actorSectionFields(
  actor: WorldActor,
  profile: ActorSystemIdentity['profile'],
  section: ActorSectionName,
  delegated: boolean,
): ActorField[] {
  if (profile === 'generic') {
    return section === 'system' && !delegated ? boundFieldValues(genericFields(actor.system)) : [];
  }
  const definitions =
    profile === 'dnd5e' ? dndDefinitions(section, delegated) : pf2eDefinitions(section, delegated);
  return boundFieldValues(
    definitions
      .slice(0, MAX_FIELDS)
      .map((definition) => fieldFromDefinition(actor.system, definition)),
  );
}

export function isActorSectionSupported(
  profile: ActorSystemIdentity['profile'],
  section: ActorSectionName,
  delegated: boolean,
): boolean {
  if (profile === 'generic') {
    return section === 'system' && !delegated;
  }
  return section !== 'system';
}

function itemDefinitions(profile: 'dnd5e' | 'pf2e', delegated: boolean): FieldDefinition[] {
  const common: FieldDefinition[] = [
    { key: 'quantity', label: 'Quantity', paths: ['quantity', 'quantity.value'] },
    { key: 'equipped', label: 'Equipped', paths: ['equipped'] },
    { key: 'identified', label: 'Identified', paths: ['identified'] },
    { key: 'weight', label: 'Weight', paths: ['weight.value', 'weight'] },
  ];
  if (profile === 'pf2e') {
    common.push({ key: 'level', label: 'Level', paths: ['level.value'] });
  }
  if (!delegated) {
    common.push({
      key: 'description',
      label: 'Description',
      paths: ['description.value'],
      richText: true,
    });
  }
  return common;
}

export function actorItemFields(
  item: WorldItem,
  profile: ActorSystemIdentity['profile'],
  delegated: boolean,
): ActorField[] {
  if (profile === 'generic') {
    return delegated ? [] : boundFieldValues(genericFields(item.system));
  }
  return boundFieldValues(
    itemDefinitions(profile, delegated).map((definition) =>
      fieldFromDefinition(item.system, definition),
    ),
  );
}

export function publicActorItemSummary(
  actorId: string,
  item: WorldItem,
  identity: ItemEconomyIdentity = { id: 'unknown' },
): ActorItemSummary {
  const directQuantity = publicScalar(scalarAt(item.system, 'quantity'), false).value;
  const quantity =
    directQuantity ?? publicScalar(scalarAt(item.system, 'quantity.value'), false).value;
  const equipped = publicScalar(scalarAt(item.system, 'equipped'), false).value;
  return {
    id: item._id,
    uuid: `Actor.${actorId}.Item.${item._id}`,
    economy: normalizeItemEconomy(item, identity),
    name: truncateUtf16(item.name, MAX_IDENTITY_TEXT_UNITS).value,
    type: truncateUtf16(item.type, 128).value,
    ...(typeof item.img === 'string' ? { img: truncateUtf16(item.img, 2048).value } : {}),
    ...(typeof quantity === 'number' ? { quantity } : {}),
    ...(typeof equipped === 'boolean' ? { equipped } : {}),
  };
}

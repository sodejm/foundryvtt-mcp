import {
  type LootGenerationOutput,
  lootGenerationOutputSchema,
  type NpcGenerationOutput,
  npcGenerationOutputSchema,
  parseLootGenerationInput,
  parseNpcGenerationInput,
} from '../../foundry/generation-contract.js';
import { boundedReadResponse } from '../../foundry/read-contract.js';

export { handleLookupRule } from './rules.js';

export type GenerationRandom = () => number;

const firstNames = ['Aven', 'Briar', 'Corin', 'Dara', 'Eris'] as const;
const lastNames = ['Ashfield', 'Brightwater', 'Cloudstep', 'Duskvale', 'Emberlane'] as const;
const personalities = [
  'Patient and observant, with a dry sense of humor.',
  'Warmly curious and quick to ask careful questions.',
  'Reserved in company but steadfast once trust is earned.',
] as const;
const appearances = [
  'Wears practical travel clothes marked by careful repairs.',
  'Carries a weathered satchel covered in hand-drawn symbols.',
  'Keeps a bright scarf as a reminder of home.',
] as const;
const motivations = [
  'Wants to settle a promise made to an old friend.',
  'Seeks a lost story before its last witnesses are gone.',
  'Hopes to protect a small community from an approaching hardship.',
] as const;
const itemIdeas = [
  {
    name: 'Map of Returning Paths',
    description: 'A hand-drawn map whose landmarks seem familiar in any country.',
  },
  {
    name: 'Lantern of Quiet Stars',
    description: 'A small lantern filled with drifting points of cool light.',
  },
  {
    name: 'Bell of Friendly Echoes',
    description: 'A copper bell whose echo resembles a distant greeting.',
  },
] as const;

function choose<T>(values: readonly T[], random: GenerationRandom): T {
  const index = Math.max(0, Math.min(values.length - 1, Math.floor(random() * values.length)));
  return values[index] as T;
}

function narrativeScale(level: number): NpcGenerationOutput['npc']['narrativeScale'] {
  if (level <= 4) {
    return 'local';
  }
  if (level <= 10) {
    return 'notable';
  }
  if (level <= 16) {
    return 'formidable';
  }
  return 'legendary';
}

function wasOmitted(value: unknown, key: string): boolean {
  return !Object.hasOwn(value as Record<string, unknown>, key);
}

/** Creates a bounded, world-independent NPC creative preview without persisting data. */
export async function handleGenerateNPC(args: unknown, random: GenerationRandom = Math.random) {
  const input = parseNpcGenerationInput(args);
  const defaultsApplied: NpcGenerationOutput['defaultsApplied'] = [];
  if (wasOmitted(args, 'level')) {
    defaultsApplied.push('level');
  }
  if (wasOmitted(args, 'race')) {
    defaultsApplied.push('race');
  }
  if (wasOmitted(args, 'class')) {
    defaultsApplied.push('class');
  }

  const structuredContent = npcGenerationOutputSchema.parse({
    schemaVersion: 1,
    preview: {
      mode: 'creative-preview',
      status: 'preview',
      persisted: false,
      rulesVerified: false,
      system: null,
      systemVersion: null,
      supportedOptions: ['level', 'race', 'class'],
      limitations: [
        'This is a world-independent creative preview, not verified system content.',
        'It does not create or modify any Foundry document.',
      ],
    },
    npc: {
      name: `${choose(firstNames, random)} ${choose(lastNames, random)}`,
      level: input.level,
      race: input.race,
      class: input.class,
      narrativeScale: narrativeScale(input.level),
      personality: choose(personalities, random),
      appearance: choose(appearances, random),
      motivation: choose(motivations, random),
      background: `${input.race} ${input.class} who operates at a ${narrativeScale(input.level)} narrative scale and ${choose(motivations, random).toLowerCase()}`,
    },
    defaultsApplied,
  });

  return boundedReadResponse({
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

/** Creates bounded fictional loot with traceable currency arithmetic and unknown item value. */
export async function handleGenerateLoot(args: unknown, random: GenerationRandom = Math.random) {
  const input = parseLootGenerationInput(args);
  const defaultsApplied: LootGenerationOutput['defaultsApplied'] = [];
  if (wasOmitted(args, 'challengeRating')) {
    defaultsApplied.push('challengeRating');
  }
  if (wasOmitted(args, 'treasureType')) {
    defaultsApplied.push('treasureType');
  }

  const multiplier = input.treasureType === 'hoard' ? 4 : 1;
  const scale = input.challengeRating + 1;
  const glints = Math.floor(scale * multiplier * (4 + random() * 5));
  const crowns = Math.floor(scale * multiplier * (1 + random() * 2));
  const subtotal = glints + crowns * 10;
  const itemCount = input.treasureType === 'hoard' ? 3 : 1;
  const items = itemIdeas.slice(0, itemCount).map((item) => ({
    ...item,
    valuation: {
      status: 'unknown' as const,
      reason: 'No verified system economy or item price source is available.',
    },
  }));

  const structuredContent = lootGenerationOutputSchema.parse({
    schemaVersion: 1,
    preview: {
      mode: 'creative-preview',
      status: 'preview',
      persisted: false,
      rulesVerified: false,
      system: null,
      systemVersion: null,
      supportedOptions: ['challengeRating', 'treasureType'],
      limitations: [
        'Challenge rating is used only as a world-independent creative scale.',
        'Currency and items are fictional and are not verified against a game system.',
        'This preview does not create or modify any Foundry document.',
      ],
    },
    loot: {
      challengeRating: input.challengeRating,
      treasureType: input.treasureType,
      denominations: [
        { code: 'glint', name: 'glints', amount: glints, unitValue: 1 },
        { code: 'crown', name: 'crowns', amount: crowns, unitValue: 10 },
      ],
      conversion: {
        baseUnit: 'glints',
        statement: '1 fictional crown equals 10 fictional glints.',
      },
      knownCurrencySubtotal: {
        amount: subtotal,
        unit: 'glints',
        basis: 'Sum of each denomination amount multiplied by its base-unit value.',
      },
      items,
      overallValue: {
        status: 'unknown',
        knownCurrencySubtotal: { amount: subtotal, unit: 'glints' },
        reason: 'Item values are unknown, so no overall value can be calculated.',
      },
    },
    defaultsApplied,
  });

  return boundedReadResponse({
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

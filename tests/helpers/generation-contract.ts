import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';
import type { LootGenerationOutput, NpcGenerationOutput } from '../../src/foundry/generation-contract.js';

export const npcCases = [
  {}, { level: 1 }, { level: 4 }, { level: 5 }, { level: 10 }, { level: 11 },
  { level: 16 }, { level: 17 }, { level: 20 },
  { race: 'Clockwork', class: 'Archivist', level: 7 },
  { race: '旅人 😀', class: '<script>literal narrative label</script>' },
  { race: 'x'.repeat(64), class: '😀'.repeat(32) },
] satisfies Record<string, unknown>[];
export const lootCases = [
  {}, { challengeRating: 0 }, { challengeRating: 0.125 }, { challengeRating: 30 },
  { challengeRating: 7, treasureType: 'individual' },
  { challengeRating: 7, treasureType: 'hoard' },
  { challengeRating: 30, treasureType: 'hoard' },
] satisfies Record<string, unknown>[];
export const invalidNpcCases = [
  { level: 0 }, { level: 21 }, { level: 1.5 }, { level: '5' }, { level: null },
  { level: false }, { level: [] }, { level: {} },
  { race: '' }, { race: '\n\t' }, { race: 'x'.repeat(65) }, { race: null },
  { race: 1 }, { race: [] }, { class: '' }, { class: ' ' },
  { class: 'x'.repeat(65) }, { class: false }, { class: {} },
  { system: 'dnd5e' }, { id: 'invented' }, { persist: true },
] satisfies Record<string, unknown>[];
export const invalidLootCases = [
  { challengeRating: -1 }, { challengeRating: 31 }, { challengeRating: '5' },
  { challengeRating: null }, { challengeRating: false }, { challengeRating: [] },
  { challengeRating: {} }, { treasureType: 'Hoard' }, { treasureType: 'unsupported' },
  { treasureType: '' }, { treasureType: null }, { treasureType: 1 },
  { system: 'dnd5e' }, { worldId: 'test1world' }, { persist: true },
] satisfies Record<string, unknown>[];

export function assertGeneration(result: CallToolResult, name: string, args: Record<string, unknown>) {
  expect(result.isError).not.toBe(true);
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
  const output = result.structuredContent as unknown as NpcGenerationOutput | LootGenerationOutput;
  expect(output).toMatchObject({ schemaVersion: 1, preview: {
    mode: 'creative-preview', status: 'preview', persisted: false,
    rulesVerified: false, system: null, systemVersion: null,
  } });
  expect(output.preview.limitations.every(value => value.length > 0)).toBe(true);
  expect(text).not.toMatch(/"(?:id|_id|uuid|actorId|itemId|documentId)"\s*:/);
  if (name === 'generate_npc') {
    const npcOutput = output as NpcGenerationOutput;
    const level = (args.level ?? 1) as number;
    expect(npcOutput.preview.supportedOptions).toEqual(['level', 'race', 'class']);
    expect(npcOutput.npc).toMatchObject({ level, race: args.race ?? 'Riverfolk', class: args.class ?? 'Wayfinder',
      narrativeScale: level <= 4 ? 'local' : level <= 10 ? 'notable' : level <= 16 ? 'formidable' : 'legendary' });
    expect(npcOutput.npc.background).toContain(npcOutput.npc.race);
    expect(npcOutput.npc.background).toContain(npcOutput.npc.class);
    expect(npcOutput.defaultsApplied).toEqual(['level', 'race', 'class'].filter(key => !Object.hasOwn(args, key)));
    for (const mechanics of ['hitPoints', 'armorClass', 'abilities', 'skills', 'challengeRating']) {
      expect(Object.hasOwn(npcOutput.npc, mechanics)).toBe(false);
    }
  } else {
    const lootOutput = output as LootGenerationOutput;
    const loot = lootOutput.loot;
    expect(lootOutput.preview.supportedOptions).toEqual(['challengeRating', 'treasureType']);
    expect(loot).toMatchObject({ challengeRating: args.challengeRating ?? 1, treasureType: args.treasureType ?? 'individual' });
    expect(loot.conversion).toEqual({ baseUnit: 'glints', statement: '1 fictional crown equals 10 fictional glints.' });
    expect(loot.denominations.map(value => [value.code, value.unitValue])).toEqual([['glint', 1], ['crown', 10]]);
    const total = loot.denominations.reduce((sum, coin) => sum + coin.amount * coin.unitValue, 0);
    expect(loot.knownCurrencySubtotal).toEqual({ amount: total, unit: 'glints',
      basis: 'Sum of each denomination amount multiplied by its base-unit value.' });
    expect(loot.items).toHaveLength(loot.treasureType === 'hoard' ? 3 : 1);
    for (const item of loot.items) expect(item.valuation).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(loot.overallValue).toEqual({ status: 'unknown', knownCurrencySubtotal: { amount: total, unit: 'glints' }, reason: expect.any(String) });
    expect(lootOutput.defaultsApplied).toEqual(['challengeRating', 'treasureType'].filter(key => !Object.hasOwn(args, key)));
  }
  return output;
}

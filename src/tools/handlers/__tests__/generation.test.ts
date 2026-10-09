import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGenerateLoot, handleGenerateNPC } from '../generation.js';

function parsedText(result: Awaited<ReturnType<typeof handleGenerateNPC>>) {
  const content = result.content[0];
  if (content?.type !== 'text') {
    throw new Error('Expected one text content item.');
  }
  return JSON.parse(content.text);
}

describe('creative generation handlers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a deterministic NPC preview with explicit defaults and matching text', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = await handleGenerateNPC({});
    const second = await handleGenerateNPC({}, () => 0);

    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(parsedText(first)).toEqual(first.structuredContent);
    expect(first.structuredContent).toMatchObject({
      preview: {
        mode: 'creative-preview',
        persisted: false,
        rulesVerified: false,
        system: null,
        systemVersion: null,
      },
      npc: {
        name: 'Aven Ashfield',
        level: 1,
        race: 'Riverfolk',
        class: 'Wayfinder',
        narrativeScale: 'local',
      },
      defaultsApplied: ['level', 'race', 'class'],
    });
  });

  it.each([
    [4, 'local'],
    [5, 'notable'],
    [11, 'formidable'],
    [17, 'legendary'],
  ] as const)('honors every NPC option and maps level %s to %s scale', async (level, scale) => {
    const result = await handleGenerateNPC(
      { level, race: 'Sky Weaver', class: 'Memory Keeper' },
      () => 0.999999,
    );
    expect(result.structuredContent).toMatchObject({
      npc: {
        level,
        race: 'Sky Weaver',
        class: 'Memory Keeper',
        narrativeScale: scale,
      },
      defaultsApplied: [],
    });
  });

  it('rejects invalid NPC input on direct handler calls', async () => {
    await expect(handleGenerateNPC({ level: 0 })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('creates traceable individual loot with explicit defaults and matching text', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = await handleGenerateLoot({});
    expect(parsedText(result)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      loot: {
        challengeRating: 1,
        treasureType: 'individual',
        denominations: [
          { code: 'glint', amount: 8, unitValue: 1 },
          { code: 'crown', amount: 2, unitValue: 10 },
        ],
        knownCurrencySubtotal: { amount: 28, unit: 'glints' },
        overallValue: { status: 'unknown' },
      },
      defaultsApplied: ['challengeRating', 'treasureType'],
    });
  });

  it('honors hoard and challenge scale while keeping item and total values unknown', async () => {
    const result = await handleGenerateLoot(
      { challengeRating: 2.5, treasureType: 'hoard' },
      () => 0.5,
    );
    const loot = result.structuredContent.loot;
    expect(loot.challengeRating).toBe(2.5);
    expect(loot.treasureType).toBe('hoard');
    expect(loot.items).toHaveLength(3);
    expect(loot.items.every((item) => item.valuation.status === 'unknown')).toBe(true);
    expect(loot.knownCurrencySubtotal.amount).toBe(
      loot.denominations.reduce((sum, entry) => sum + entry.amount * entry.unitValue, 0),
    );
    expect(loot.overallValue.status).toBe('unknown');
    expect(result.structuredContent.defaultsApplied).toEqual([]);
  });

  it('rejects invalid loot input on direct handler calls', async () => {
    await expect(handleGenerateLoot({ treasureType: 'cache' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });
});

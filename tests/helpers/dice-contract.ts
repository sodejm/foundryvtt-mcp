import { expect } from 'vitest';

export const validDiceCases = [
  '1d20+5', 'd6', 'D6', '2D6KH1', '2d6-3', '4d6kh3', '4d6kl2', '4d6dh1', '4d6dl1',
  '2d6kh', '2d6kl', '2d6dh', '2d6dl', '0d6', '0d6kh', '2d1kh1',
  '(2d6 + 3) - (1d4 - 2)', '-(2d6kh1 + 3) + (1d4 - 2)',
  '+1d6', '1d6 - -2', '((7 - 3) + 2)', '999d1', '500d1+500d1', '1d1000000',
  '1000000000', `${'('.repeat(10)}1${')'.repeat(10)}`,
  Array(50).fill('1').join('+'), `1d6${' '.repeat(97)}`,
  `${'-'.repeat(97)}1d6`,
];

export const invalidDiceCases: Record<string, unknown>[] = [
  {}, { formula: '' }, { formula: ' ' }, { formula: 2 }, { formula: null },
  { formula: '1d6', unknown: true }, { formula: '1d6', engine: 'remote' },
  { formula: '1d6', engine: '' }, { formula: '1d6', engine: null },
  { formula: '1d6', engine: 1 }, { formula: '1d6', reason: '' },
  { formula: '1d6', reason: ' ' }, { formula: '1d6', reason: null },
  { formula: '1d6', reason: 1 }, { formula: '1d6', reason: 'x'.repeat(257) },
  ...['1d6*2', '1d6/2', '1d6r1', '1d6!', '1d6kh1dl1', '{1d6,1d4}', '@actor.hp',
    '1d6junk', '1d6 +', '()', '(1d6', '1d6)', '1d0', '1000d1', '1001d6', '600d6+600d6',
    '1d1000001', '1000000001', '1.5', 'Infinity', 'NaN', '1e3', '1d6;process.exit()',
    '2d6kh0', '2d6dh0', '2d6dh3', '2d6kl3',
    `${'('.repeat(11)}1${')'.repeat(11)}`, '1'.repeat(101), `1d6${' '.repeat(98)}`,
  ].map(formula => ({ formula })),
];

export function assertDice(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}, engine: 'local' | 'foundry') {
  expect(result.isError).not.toBe(true);
  const value = result.structuredContent!;
  expect(value).toBeDefined();
  expect(value.schemaVersion).toBe(1);
  expect(value.engine).toBe(engine);
  expect(value.normalizedFormula).toEqual(expect.any(String));
  expect(Number.isSafeInteger(value.total)).toBe(true);
  expect(value.breakdown).toEqual(expect.any(String));
  expect(Number.isFinite(Date.parse(value.timestamp as string))).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  expect(JSON.parse(result.content[0]!.text!)).toEqual(value);
  const dice = value.dice as Array<{
    termIndex: number; formula: string; count: number; faces: number;
    modifier: { type: 'kh' | 'kl' | 'dh' | 'dl'; count: number } | null;
    results: Array<{ result: number; active: boolean }>;
  }>;
  expect(dice.length).toBeLessThanOrEqual(50);
  expect(dice.reduce((count, die) => count + die.count, 0)).toBeLessThanOrEqual(1000);
  for (const [index, die] of dice.entries()) {
    expect(die.termIndex).toBe(index);
    expect(die.formula).toEqual(expect.any(String));
    expect(die.formula.length).toBeGreaterThan(0);
    expect(Number.isSafeInteger(die.count)).toBe(true);
    expect(Number.isSafeInteger(die.faces)).toBe(true);
    expect(die.count).toBeGreaterThanOrEqual(0);
    expect(die.count).toBeLessThanOrEqual(999);
    expect(die.faces).toBeGreaterThanOrEqual(1);
    expect(die.faces).toBeLessThanOrEqual(1000000);
    if (die.modifier !== null) {
      expect(['kh', 'kl', 'dh', 'dl']).toContain(die.modifier.type);
      expect(Number.isSafeInteger(die.modifier.count)).toBe(true);
      expect(die.modifier.count).toBeGreaterThanOrEqual(1);
      expect(die.modifier.count).toBeLessThanOrEqual(Math.max(1, die.count));
    }
    expect(die.results).toHaveLength(die.count);
    for (const outcome of die.results) {
      expect(Number.isInteger(outcome.result)).toBe(true);
      expect(outcome.result).toBeGreaterThanOrEqual(1);
      expect(outcome.result).toBeLessThanOrEqual(die.faces);
      expect(typeof outcome.active).toBe('boolean');
    }
  }
  return value;
}

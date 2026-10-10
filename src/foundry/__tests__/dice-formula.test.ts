import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BinaryNode,
  evaluateDiceFormula,
  evaluateParsedDiceFormula,
  InvalidDiceFormulaError,
  type ParsedDiceFormula,
  parseDiceFormula,
  validateDiceOutcomes,
  validateParsedDiceOutcomes,
} from '../dice-formula.js';

function sequence(values: unknown[]): () => number {
  let index = 0;
  return () => values[index++] as number;
}

afterEach(() => vi.restoreAllMocks());

describe('parseDiceFormula', () => {
  it('normalizes bounded Foundry syntax without changing its meaning', () => {
    const parsed = parseDiceFormula(' -(2D6KH1 + 3) + (d4 - 2) ');
    expect(parsed).toMatchObject({
      normalizedFormula: '0 - (2d6kh1 + 3) + (1d4 - 2)',
      diceCount: 3,
      termCount: 4,
    });
    expect(evaluateParsedDiceFormula(parsed, sequence([0, 0.9, 0.5])).total).toBe(-9);
  });

  it('parenthesizes nested unary expressions', () => {
    expect(parseDiceFormula('1d6 - -2').normalizedFormula).toBe('1d6 - (0 - (2))');
    expect(evaluateDiceFormula('1d6 - -2', () => 0).total).toBe(8);
    expect(evaluateDiceFormula('+1').total).toBe(1);
  });

  it('accepts every public numeric and structural boundary', () => {
    expect(parseDiceFormula('999d1000000')).toMatchObject({ diceCount: 999, termCount: 1 });
    expect(parseDiceFormula('500d1+500d1')).toMatchObject({ diceCount: 1000, termCount: 2 });
    expect(parseDiceFormula('1000000000').termCount).toBe(1);
    expect(parseDiceFormula(Array(50).fill('0').join('+'))).toMatchObject({
      termCount: 50,
      normalizedFormula: Array(50).fill('0').join(' + '),
    });
    expect(parseDiceFormula(`${'('.repeat(10)}1${')'.repeat(10)}`).termCount).toBe(1);
    expect(parseDiceFormula(`1d6${' '.repeat(97)}`).normalizedFormula).toBe('1d6');
  });

  it('collapses long unary chains without nesting normalized output', () => {
    const formula = `${'-'.repeat(97)}1d6`;
    expect(formula).toHaveLength(100);
    const parsed = parseDiceFormula(formula);
    expect(parsed.normalizedFormula).toBe('0 - (1d6)');
    expect(evaluateParsedDiceFormula(parsed, () => 0).total).toBe(-6);
    expect(parseDiceFormula(`${'-'.repeat(96)}1d6`).normalizedFormula).toBe('1d6');
    expect(parseDiceFormula('1d6 - +-+2').normalizedFormula).toBe('1d6 - (0 - (2))');
    expect(parseDiceFormula('1d6 - +(2 - 1)').normalizedFormula).toBe('1d6 - (2 - 1)');
  });

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    [`1${' '.repeat(100)}`, /maximum length/],
    ['d', /side count/],
    ['1d0', /die sides/],
    ['1d1000001', /die sides/],
    ['1000d6', /at most 999/],
    ['501d6+500d6', /aggregate dice limit/],
    ['1000000001', /constants may not exceed/],
    ['9007199254740992', /constant must be a safe integer/],
    ['9007199254740992d6', /dice count must be a safe integer/],
    ['1d9007199254740992', /side count must be a safe integer/],
    ['2d6kh0', /explicit modifier count/],
    ['2d6dh3', /cannot exceed/],
    ['0d6kh2', /cannot exceed/],
    [`${'('.repeat(11)}1${')'.repeat(11)}`, /nested at most/],
    ['(1d6', /expected/],
    ['()', /unexpected/],
    ['1d6+', /end of input/],
    ['1d6 2', /unexpected/],
    ['1d6*2', /unexpected/],
    ['1d6)', /unexpected/],
    ['2d6kx1', /unexpected/],
  ] as const)('rejects malformed or out-of-bounds input %j', (formula, message) => {
    expect(() => parseDiceFormula(formula)).toThrow(message);
  });
});

describe('evaluateDiceFormula', () => {
  it('preserves result order and applies keep modifiers', () => {
    const result = evaluateDiceFormula('4d6kh2', sequence([0.9, 0, 0.4, 0.2]));
    expect(result.dice[0]).toEqual({
      formula: '4d6kh2',
      count: 4,
      faces: 6,
      modifier: { type: 'kh', count: 2 },
      results: [
        { result: 1, active: false },
        { result: 6, active: true },
        { result: 4, active: false },
        { result: 5, active: true },
      ],
    });
    expect(result.total).toBe(11);
    expect(result.breakdown).toBe('4d6kh2: [~1~, 6, ~4~, 5] = 11');
    expect(result.terms).toEqual([{ kind: 'dice', value: 11, rolls: [1, 6, 4, 5] }]);
  });

  it.each([
    ['kh', [false, true, false, true], 11],
    ['kl', [true, false, true, false], 5],
    ['dh', [true, false, true, false], 5],
    ['dl', [false, true, false, true], 11],
  ] as const)('implements %s with Foundry ordering', (modifier, flags, total) => {
    const result = evaluateDiceFormula(`4d6${modifier}2`, sequence([0.9, 0, 0.4, 0.2]));
    expect(result.dice[0]?.results.map(({ active }) => active)).toEqual(flags);
    expect(result.total).toBe(total);
  });

  it.each(['kh', 'kl', 'dh', 'dl'] as const)('uses Foundry tie selection for %s', (modifier) => {
    expect(
      evaluateDiceFormula(`4d6${modifier}2`, () => 0.5).dice[0]?.results.map(
        ({ active }) => active,
      ),
    ).toEqual([false, false, true, true]);
  });

  it.each([
    '1d6dh',
    '1d6dh1',
    '1d6dl',
    '1d6dl1',
    '2d6dh2',
    '2d6dl2',
    '4d6dh4',
    '4d6dl4',
  ])('preserves all outcomes for native drop-all formula %s', (formula) => {
    const result = evaluateDiceFormula(formula, () => 0);
    expect(result.dice[0]?.results.every(({ active }) => active)).toBe(true);
    expect(result.total).toBe(Number(formula[0]) * 6);
  });

  it('supports zero dice without consuming randomness', () => {
    const rng = vi.fn(() => 0);
    const result = evaluateDiceFormula('0d6kh+2', rng);
    expect(rng).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 2, breakdown: '0d6kh1: [] = 2' });
  });

  it('renders a constant-only breakdown', () => {
    expect(evaluateDiceFormula('10-4')).toMatchObject({
      total: 6,
      breakdown: '10 - 4 = 6',
      dice: [],
    });
  });

  it('uses Math.random only when no RNG was supplied', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(evaluateDiceFormula('d6').total).toBe(6);
    expect(random).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    null,
    '0',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0.1,
    1,
  ])('rejects injected RNG result %j without falling back to Math.random', (uniform) => {
    const random = vi.spyOn(Math, 'random');
    expect(() => evaluateDiceFormula('d6', () => uniform as number)).toThrow(
      /finite value in \[0, 1\)/,
    );
    expect(random).not.toHaveBeenCalled();
  });

  it('rejects intermediate and final totals outside the safe integer range', () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const binary: BinaryNode = {
      kind: 'binary',
      operator: '+',
      left: { kind: 'constant', value: huge },
      right: { kind: 'constant', value: 1 },
    };
    const parsed: ParsedDiceFormula = {
      ast: binary,
      normalizedFormula: 'unsafe',
      diceCount: 0,
      termCount: 2,
    };
    expect(() => evaluateParsedDiceFormula(parsed)).toThrow(/safe integer/);

    const finalOnly: ParsedDiceFormula = {
      ...parsed,
      ast: { kind: 'constant', value: huge + 1 },
      termCount: 1,
    };
    expect(() => evaluateParsedDiceFormula(finalOnly)).toThrow(InvalidDiceFormulaError);
  });
});

describe('Foundry outcome validation', () => {
  const formula = '2d6kh1+1d4-2';
  const parsed = parseDiceFormula(formula);
  const valid = [
    {
      faces: 6,
      results: [
        { result: 6, active: true },
        { result: 1, active: false },
      ],
    },
    { faces: 4, results: [{ result: 2, active: true }] },
  ];

  it('validates exact outcomes, active flags, order, and arithmetic', () => {
    const result = validateParsedDiceOutcomes(parsed, valid);
    expect(result.total).toBe(6);
    expect(validateDiceOutcomes(formula, valid)).toEqual(result);
  });

  it.each([
    [[], /do not match/],
    [[{ ...valid[0], faces: 8 }, valid[1]], /do not match/],
    [[{ ...valid[0], results: valid[0].results.slice(0, 1) }, valid[1]], /do not match/],
    [
      [{ ...valid[0], results: [{ result: 0, active: true }, valid[0].results[1]] }, valid[1]],
      /invalid die/,
    ],
    [
      [{ ...valid[0], results: [{ result: 7, active: true }, valid[0].results[1]] }, valid[1]],
      /invalid die/,
    ],
    [
      [{ ...valid[0], results: [{ result: 1.5, active: true }, valid[0].results[1]] }, valid[1]],
      /invalid die/,
    ],
    [
      [{ ...valid[0], results: [{ result: 6, active: false }, valid[0].results[1]] }, valid[1]],
      /active flags/,
    ],
    [[...valid, { faces: 8, results: [] }], /extra dice/],
  ] as const)('rejects mismatched outcome set %#', (outcomes, message) => {
    expect(() => validateParsedDiceOutcomes(parsed, outcomes as never)).toThrow(message);
  });
});

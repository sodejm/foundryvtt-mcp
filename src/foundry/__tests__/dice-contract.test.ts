import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  DICE_REASON_MAX_LENGTH,
  diceRollInputJsonSchema,
  diceRollOutputJsonSchema,
  diceRollOutputSchema,
  parseDiceRollInput,
} from '../dice-contract.js';
import {
  MAX_DICE_FORMULA_LENGTH,
  MAX_DICE_PER_TERM,
  MAX_DICE_SIDES,
  MAX_DICE_TERMS,
} from '../dice-formula.js';

const localOutput = {
  schemaVersion: 1,
  engine: 'local',
  normalizedFormula: '2d6kh1 + 3',
  dice: [
    {
      termIndex: 0,
      formula: '2d6kh1',
      count: 2,
      faces: 6,
      modifier: { type: 'kh', count: 1 },
      results: [
        { result: 6, active: true },
        { result: 1, active: false },
      ],
    },
  ],
  total: 9,
  breakdown: '2d6kh1: [6, ~1~] = 9',
  timestamp: '2026-10-09T12:34:56.000Z',
  reason: 'initiative',
  fallback: null,
} as const;

describe('dice roll contract', () => {
  it('parses bounded requests and applies the auto default', () => {
    expect(parseDiceRollInput({ formula: 'd20' })).toEqual({
      formula: 'd20',
      engine: 'auto',
    });
    expect(
      parseDiceRollInput({
        formula: 'f'.repeat(MAX_DICE_FORMULA_LENGTH),
        reason: 'r'.repeat(DICE_REASON_MAX_LENGTH),
        engine: 'foundry',
      }),
    ).toEqual({
      formula: 'f'.repeat(MAX_DICE_FORMULA_LENGTH),
      reason: 'r'.repeat(DICE_REASON_MAX_LENGTH),
      engine: 'foundry',
    });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { formula: '' },
    { formula: ' \n\t' },
    { formula: 'd'.repeat(MAX_DICE_FORMULA_LENGTH + 1) },
    { formula: 20 },
    { formula: 'd20', reason: '' },
    { formula: 'd20', reason: ' \t' },
    { formula: 'd20', reason: 'r'.repeat(DICE_REASON_MAX_LENGTH + 1) },
    { formula: 'd20', reason: null },
    { formula: 'd20', engine: '' },
    { formula: 'd20', engine: null },
    { formula: 'd20', engine: 1 },
    { formula: 'd20', engine: 'remote' },
    { formula: 'd20', unknown: true },
  ])('rejects malformed request input as InvalidParams: %j', (input) => {
    expect(() => parseDiceRollInput(input)).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams }),
    );
  });

  it('advertises strict bounded input JSON Schema', () => {
    const validate = new Ajv().compile(diceRollInputJsonSchema);
    for (const valid of [
      { formula: 'd20' },
      { formula: 'd20', reason: 'initiative', engine: 'local' },
      {
        formula: 'f'.repeat(MAX_DICE_FORMULA_LENGTH),
        reason: 'r'.repeat(DICE_REASON_MAX_LENGTH),
        engine: 'foundry',
      },
    ]) {
      expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const invalid of [
      {},
      { formula: ' ' },
      { formula: 'f'.repeat(MAX_DICE_FORMULA_LENGTH + 1) },
      { formula: 'd20', reason: ' ' },
      { formula: 'd20', reason: 'r'.repeat(DICE_REASON_MAX_LENGTH + 1) },
      { formula: 'd20', engine: 'remote' },
      { formula: 'd20', extra: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('accepts strict local, foundry, and auto-fallback output variants', () => {
    expect(diceRollOutputSchema.parse(localOutput)).toEqual(localOutput);
    expect(
      diceRollOutputSchema.parse({
        ...localOutput,
        reason: undefined,
        engine: 'foundry',
        dice: [{ ...localOutput.dice[0], modifier: null }],
      }),
    ).toMatchObject({ engine: 'foundry', dice: [{ modifier: null }] });
    expect(
      diceRollOutputSchema.parse({
        ...localOutput,
        reason: undefined,
        fallback: {
          requestedEngine: 'auto',
          reason: 'foundry-transport-not-configured',
        },
      }),
    ).toMatchObject({
      fallback: {
        requestedEngine: 'auto',
        reason: 'foundry-transport-not-configured',
      },
    });
  });

  it('advertises every output bound and rejects unknown or invented fields', () => {
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      diceRollOutputJsonSchema,
    );
    const boundary = {
      ...localOutput,
      dice: Array.from({ length: MAX_DICE_TERMS }, (_, termIndex) => ({
        termIndex,
        formula: `${MAX_DICE_PER_TERM}d${MAX_DICE_SIDES}dl${MAX_DICE_PER_TERM}`,
        count: MAX_DICE_PER_TERM,
        faces: MAX_DICE_SIDES,
        modifier: { type: 'dl', count: MAX_DICE_PER_TERM },
        results: Array.from({ length: MAX_DICE_PER_TERM }, () => ({
          result: MAX_DICE_SIDES,
          active: true,
        })),
      })),
      total: Number.MAX_SAFE_INTEGER,
    };
    expect(validate(localOutput), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(boundary), JSON.stringify(validate.errors)).toBe(true);

    for (const invalid of [
      { ...localOutput, extra: true },
      { ...localOutput, schemaVersion: 2 },
      { ...localOutput, engine: 'auto' },
      { ...localOutput, normalizedFormula: '' },
      { ...localOutput, total: Number.MAX_SAFE_INTEGER + 1 },
      { ...localOutput, breakdown: '' },
      { ...localOutput, timestamp: 1 },
      { ...localOutput, reason: ' ' },
      { ...localOutput, fallback: { requestedEngine: 'foundry', reason: 'missing' } },
      { ...localOutput, dice: Array(MAX_DICE_TERMS + 1).fill(localOutput.dice[0]) },
      { ...localOutput, dice: [{ ...localOutput.dice[0], termIndex: MAX_DICE_TERMS }] },
      { ...localOutput, dice: [{ ...localOutput.dice[0], formula: '' }] },
      { ...localOutput, dice: [{ ...localOutput.dice[0], count: MAX_DICE_PER_TERM + 1 }] },
      { ...localOutput, dice: [{ ...localOutput.dice[0], faces: MAX_DICE_SIDES + 1 }] },
      {
        ...localOutput,
        dice: [{ ...localOutput.dice[0], modifier: { type: 'keep', count: 1 } }],
      },
      {
        ...localOutput,
        dice: [
          {
            ...localOutput.dice[0],
            results: Array(MAX_DICE_PER_TERM + 1).fill({ result: 1, active: true }),
          },
        ],
      },
      {
        ...localOutput,
        dice: [{ ...localOutput.dice[0], results: [{ result: 0, active: true }] }],
      },
      {
        ...localOutput,
        dice: [{ ...localOutput.dice[0], results: [{ result: 1, active: true, extra: 1 }] }],
      },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });
});

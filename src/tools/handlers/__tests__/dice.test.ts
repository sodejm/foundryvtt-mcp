import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { DiceRollOutput } from '../../../foundry/dice-contract.js';
import * as parser from '../../../foundry/dice-formula.js';
import { handleRollDice } from '../dice.js';

function result(formula = '2d6kh1+3'): DiceRollOutput {
  const roll = parser.evaluateDiceFormula(formula, () => 0.5);
  return {
    schemaVersion: 1,
    engine: 'local',
    normalizedFormula: roll.normalizedFormula,
    dice: roll.dice.map((die, termIndex) => ({ ...die, termIndex })),
    total: roll.total,
    breakdown: roll.breakdown,
    timestamp: '2026-10-09T12:00:00.000Z',
    fallback: null,
  };
}

function client(roll: unknown = result()): FoundryClient {
  return { rollDice: vi.fn().mockResolvedValue(roll) } as unknown as FoundryClient;
}

afterEach(() => vi.restoreAllMocks());

describe('roll_dice shared handler', () => {
  it.each([
    'auto',
    'local',
    'foundry',
  ] as const)('passes engine %s and returns identical JSON and structured output', async (engine) => {
    const roll = {
      ...result(),
      engine: engine === 'foundry' ? 'foundry' : 'local',
      reason: 'attack',
    };
    const foundry = client(roll);
    const response = await handleRollDice(
      { formula: '2d6kh1+3', reason: 'attack', engine },
      foundry,
    );
    expect(response.structuredContent).toEqual(roll);
    expect(JSON.parse(response.content[0]?.text ?? '')).toEqual(roll);
    expect(foundry.rollDice).toHaveBeenCalledExactlyOnceWith('2d6kh1+3', 'attack', engine);
  });

  it('defaults the engine and preserves fallback provenance', async () => {
    const roll = {
      ...result(),
      fallback: { requestedEngine: 'auto', reason: 'foundry-transport-not-configured' },
    };
    const foundry = client(roll);
    expect((await handleRollDice({ formula: '2d6kh1+3' }, foundry)).structuredContent).toEqual(
      roll,
    );
    expect(foundry.rollDice).toHaveBeenCalledExactlyOnceWith('2d6kh1+3', undefined, 'auto');
  });

  it.each([
    {},
    { formula: 2 },
    { formula: '' },
    { formula: ' ' },
    { formula: 'd6', engine: 'other' },
    { formula: 'd6', reason: '' },
    { formula: 'd6', unexpected: true },
    { formula: 'd6r1' },
    { formula: 'd6+trash' },
    { formula: '1000d6' },
  ])('rejects invalid input before execution: %j', async (args) => {
    const foundry = client();
    await expect(handleRollDice(args, foundry)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(foundry.rollDice).not.toHaveBeenCalled();
  });

  it('does not classify unexpected parser failures as invalid parameters', async () => {
    const foundry = client();
    vi.spyOn(parser, 'parseDiceFormula').mockImplementation(() => {
      throw new Error('parser failed');
    });
    await expect(handleRollDice({ formula: 'd6' }, foundry)).rejects.toMatchObject({
      code: ErrorCode.InternalError,
    });
    expect(foundry.rollDice).not.toHaveBeenCalled();
  });

  it('rejects malformed execution output instead of publishing a successful result', async () => {
    const foundry = client({ ...result(), total: '6' });
    await expect(handleRollDice({ formula: 'd6' }, foundry)).rejects.toMatchObject({
      code: ErrorCode.InternalError,
    });
    expect(foundry.rollDice).toHaveBeenCalledOnce();
  });

  it('preserves an MCP failure without a second roll', async () => {
    const foundry = client();
    const error = new McpError(ErrorCode.InvalidParams, 'execution rejected');
    vi.mocked(foundry.rollDice).mockRejectedValue(error);
    await expect(handleRollDice({ formula: 'd6' }, foundry)).rejects.toBe(error);
    expect(foundry.rollDice).toHaveBeenCalledOnce();
  });

  it('reports uncertain transport failures without a second roll', async () => {
    const foundry = client();
    vi.mocked(foundry.rollDice).mockRejectedValue(
      new Error('no retry or local fallback was attempted'),
    );
    await expect(handleRollDice({ formula: 'd6', engine: 'foundry' }, foundry)).rejects.toThrow(
      'no retry or local fallback',
    );
    expect(foundry.rollDice).toHaveBeenCalledOnce();
  });
});

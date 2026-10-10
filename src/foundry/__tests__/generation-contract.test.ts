import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  GENERATION_LABEL_MAX_LENGTH,
  lootGenerationInputJsonSchema,
  lootGenerationOutputJsonSchema,
  npcGenerationInputJsonSchema,
  npcGenerationOutputJsonSchema,
  parseLootGenerationInput,
  parseNpcGenerationInput,
} from '../generation-contract.js';

describe('generation contract', () => {
  it('applies documented defaults and accepts all inclusive boundaries', () => {
    expect(parseNpcGenerationInput({})).toEqual({
      level: 1,
      race: 'Riverfolk',
      class: 'Wayfinder',
    });
    expect(
      parseNpcGenerationInput({
        level: 20,
        race: 'r'.repeat(GENERATION_LABEL_MAX_LENGTH),
        class: 'c'.repeat(GENERATION_LABEL_MAX_LENGTH),
      }),
    ).toMatchObject({ level: 20 });
    expect(parseLootGenerationInput({})).toEqual({
      challengeRating: 1,
      treasureType: 'individual',
    });
    expect(parseLootGenerationInput({ challengeRating: 0, treasureType: 'hoard' })).toEqual({
      challengeRating: 0,
      treasureType: 'hoard',
    });
    expect(parseLootGenerationInput({ challengeRating: 30 })).toMatchObject({
      challengeRating: 30,
    });
  });

  it.each([
    null,
    { level: 0 },
    { level: 21 },
    { level: 1.5 },
    { level: Number.NaN },
    { level: Number.POSITIVE_INFINITY },
    { level: '1' },
    { race: '' },
    { race: ' ' },
    { race: 'r'.repeat(GENERATION_LABEL_MAX_LENGTH + 1) },
    { race: 1 },
    { class: '' },
    { class: ' ' },
    { class: 'c'.repeat(GENERATION_LABEL_MAX_LENGTH + 1) },
    { class: 1 },
    { unknown: true },
  ])('rejects invalid NPC input: %j', (input) => {
    expect(() => parseNpcGenerationInput(input)).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams }),
    );
  });

  it.each([
    null,
    { challengeRating: -1 },
    { challengeRating: 31 },
    { challengeRating: Number.NaN },
    { challengeRating: Number.POSITIVE_INFINITY },
    { challengeRating: '1' },
    { treasureType: 'cache' },
    { treasureType: 1 },
    { unknown: true },
  ])('rejects invalid loot input: %j', (input) => {
    expect(() => parseLootGenerationInput(input)).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams }),
    );
  });

  it('advertises strict input and output schemas with documented defaults', () => {
    for (const schema of [
      npcGenerationInputJsonSchema,
      npcGenerationOutputJsonSchema,
      lootGenerationInputJsonSchema,
      lootGenerationOutputJsonSchema,
    ]) {
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(npcGenerationInputJsonSchema).toHaveProperty('properties.level.default', 1);
    expect(npcGenerationInputJsonSchema).toHaveProperty('properties.race.default', 'Riverfolk');
    expect(lootGenerationInputJsonSchema).toHaveProperty(
      'properties.treasureType.default',
      'individual',
    );
  });
});

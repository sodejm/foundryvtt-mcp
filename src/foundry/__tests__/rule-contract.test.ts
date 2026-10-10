import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  parseRuleLookupInput,
  RULE_LOOKUP_QUERY_MAX_LENGTH,
  RULE_LOOKUP_SYSTEM_MAX_LENGTH,
  ruleLookupInputJsonSchema,
  ruleLookupOutputJsonSchema,
} from '../rule-contract.js';

const unavailableOutput = {
  schemaVersion: 1,
  capability: {
    feature: 'rulesLookup',
    status: 'unavailable',
    reason: 'No verified rules provider is implemented.',
    remediation: 'Consult an authoritative rules source.',
  },
};

describe('rule lookup contract', () => {
  it.each([
    [{ query: 'grapple' }, { query: 'grapple' }],
    [
      {
        query: 'q'.repeat(RULE_LOOKUP_QUERY_MAX_LENGTH),
        system: 's'.repeat(RULE_LOOKUP_SYSTEM_MAX_LENGTH),
      },
      {
        query: 'q'.repeat(RULE_LOOKUP_QUERY_MAX_LENGTH),
        system: 's'.repeat(RULE_LOOKUP_SYSTEM_MAX_LENGTH),
      },
    ],
  ])('parses bounded inputs and preserves optional fields: %j', (input, expected) => {
    expect(parseRuleLookupInput(input)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { query: '' },
    { query: '   \n\t' },
    { query: 'q'.repeat(RULE_LOOKUP_QUERY_MAX_LENGTH + 1) },
    { query: 42 },
    { query: 'grapple', system: '' },
    { query: 'grapple', system: ' \t' },
    { query: 'grapple', system: 's'.repeat(RULE_LOOKUP_SYSTEM_MAX_LENGTH + 1) },
    { query: 'grapple', system: 5 },
    { query: 'grapple', unknown: true },
  ])('rejects malformed input as InvalidParams: %j', (input) => {
    expect(() => parseRuleLookupInput(input)).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams }),
    );
  });

  it('advertises strict draft-7 input bounds', () => {
    const validate = new Ajv().compile(ruleLookupInputJsonSchema);
    expect(validate({ query: 'grapple' })).toBe(true);
    expect(
      validate({
        query: 'q'.repeat(RULE_LOOKUP_QUERY_MAX_LENGTH),
        system: 's'.repeat(RULE_LOOKUP_SYSTEM_MAX_LENGTH),
      }),
    ).toBe(true);
    for (const invalid of [
      {},
      { query: ' ' },
      { query: 'q'.repeat(RULE_LOOKUP_QUERY_MAX_LENGTH + 1) },
      { query: 'q', system: ' ' },
      { query: 'q', system: 's'.repeat(RULE_LOOKUP_SYSTEM_MAX_LENGTH + 1) },
      { query: 'q', extra: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('advertises only the strict unavailable output', () => {
    const validate = new Ajv().compile(ruleLookupOutputJsonSchema);
    expect(validate(unavailableOutput)).toBe(true);
    for (const invalid of [
      { ...unavailableOutput, result: 'invented' },
      { ...unavailableOutput, schemaVersion: 2 },
      { schemaVersion: 1 },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, status: 'available' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, feature: 'compendiumSearch' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, reason: '' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, remediation: 'x'.repeat(513) },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, provider: 'unverified' },
      },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });
});

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH,
  errorDiagnosisInputJsonSchema,
  errorDiagnosisOutputJsonSchema,
  parseErrorDiagnosisInput,
} from '../diagnosis-contract.js';

const unavailableOutput = {
  schemaVersion: 1,
  capability: {
    feature: 'diagnostics',
    status: 'unavailable',
    reason: 'No verified diagnostic source is implemented.',
    remediation: 'Inspect authoritative server logs.',
  },
};

describe('error diagnosis contract', () => {
  it.each([
    [{}, {}],
    [{ category: 'module error' }, { category: 'module error' }],
    [{ category: '✨' }, { category: '✨' }],
    [
      { category: 'c'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH) },
      { category: 'c'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH) },
    ],
  ])('parses bounded optional input: %j', (input, expected) => {
    expect(parseErrorDiagnosisInput(input)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    [],
    '',
    { category: '' },
    { category: '   \n\t' },
    { category: 'c'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH + 1) },
    { category: 42 },
    { unknown: true },
    { category: 'module', timeframe: '1h' },
    { category: 'module', since: 'yesterday' },
    { category: 'module', limit: 10 },
  ])('rejects malformed input as InvalidParams: %j', (input) => {
    expect(() => parseErrorDiagnosisInput(input)).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidParams }),
    );
  });

  it('advertises strict draft-7 input bounds', () => {
    const validate = new Ajv().compile(errorDiagnosisInputJsonSchema);
    expect(validate({})).toBe(true);
    expect(validate({ category: '✨'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH) })).toBe(true);
    for (const invalid of [
      null,
      [],
      { category: '' },
      { category: ' \t' },
      { category: 'c'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH + 1) },
      { category: 1 },
      { extra: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('advertises only the strict unavailable output', () => {
    const validate = new Ajv().compile(errorDiagnosisOutputJsonSchema);
    expect(validate(unavailableOutput)).toBe(true);
    for (const invalid of [
      { ...unavailableOutput, errors: [] },
      { ...unavailableOutput, schemaVersion: 2 },
      { schemaVersion: 1 },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, feature: 'rulesLookup' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, status: 'available' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, reason: '' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, reason: 'r'.repeat(513) },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, remediation: '' },
      },
      {
        ...unavailableOutput,
        capability: { ...unavailableOutput.capability, remediation: 'r'.repeat(513) },
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

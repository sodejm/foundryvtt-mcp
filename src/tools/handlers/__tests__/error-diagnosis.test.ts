import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTICS_UNAVAILABLE } from '../../../foundry/capabilities.js';
import {
  ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH,
  errorDiagnosisOutputJsonSchema,
} from '../../../foundry/diagnosis-contract.js';
import { getAllTools } from '../../definitions.js';
import { handleDiagnoseErrors as compatibilityHandler } from '../diagnostics.js';
import { handleDiagnoseErrors } from '../error-diagnosis.js';

describe('truthful error diagnosis handler', () => {
  it.each([
    {},
    { category: 'module error' },
    { category: 'unknown category' },
    { category: '✨'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH) },
  ])('returns the same bounded unavailable fact without a diagnostic source: %j', async (input) => {
    expect(handleDiagnoseErrors).toHaveLength(1);
    const result = await handleDiagnoseErrors(input);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      capability: DIAGNOSTICS_UNAVAILABLE,
    });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);

    const serialized = JSON.stringify(result);
    if ('category' in input) {
      expect(serialized).not.toContain(input.category);
    }
    for (const forbidden of [
      'errors',
      'recommendations',
      'systemStatus',
      'Operational',
      'health',
      'evidence',
      'verifiedAt',
      'provider',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    undefined,
    null,
    [],
    { category: '' },
    { category: ' ' },
    { category: 'c'.repeat(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH + 1) },
    { category: 1 },
    { category: 'module', extra: true },
  ])('rejects invalid direct input as InvalidParams: %j', async (input) => {
    await expect(handleDiagnoseErrors(input)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('retains the diagnostics-module compatibility export', () => {
    expect(compatibilityHandler).toBe(handleDiagnoseErrors);
  });

  it('advertises strict input/output schemas and hides the tool in delegated discovery', async () => {
    const tool = getAllTools(false).find(({ name }) => name === 'diagnose_errors');
    expect(tool).toBeDefined();
    expect(getAllTools(true).some(({ name }) => name === 'diagnose_errors')).toBe(false);

    const result = await handleDiagnoseErrors({ category: 'module' });
    const ajv = new Ajv();
    const validateInput = ajv.compile(tool?.inputSchema ?? {});
    const validateOutput = ajv.compile(tool?.outputSchema ?? errorDiagnosisOutputJsonSchema);
    expect(validateInput({})).toBe(true);
    expect(validateInput({ category: 'module' })).toBe(true);
    expect(validateInput({ category: 'module', extra: true })).toBe(false);
    expect(validateOutput(result.structuredContent)).toBe(true);
    expect(validateOutput({ ...result.structuredContent, category: 'module' })).toBe(false);
  });
});

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { RULES_LOOKUP_UNAVAILABLE } from '../../../foundry/capabilities.js';
import type { FoundryClient } from '../../../foundry/client.js';
import { ruleLookupOutputJsonSchema } from '../../../foundry/rule-contract.js';
import { getAllTools } from '../../definitions.js';
import { handleLookupRule as compatibilityHandler } from '../generation.js';
import { handleLookupRule } from '../rules.js';

function inaccessibleClient(): FoundryClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`Unexpected Foundry access: ${String(property)}`);
      },
    },
  ) as FoundryClient;
}

describe('truthful rule lookup handler', () => {
  it.each([
    { query: 'grapple' },
    { query: 'made up rule', system: 'unknown-system' },
    { query: 'q'.repeat(256), system: 's'.repeat(128) },
  ])('returns the same bounded unavailable fact without backend access: %j', async (input) => {
    const result = await handleLookupRule(input, inaccessibleClient());
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      capability: RULES_LOOKUP_UNAVAILABLE,
    });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    const serialized = JSON.stringify(result);
    for (const forbidden of [input.query, 'result', 'matches', 'provenance', 'citation']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    {},
    { query: '' },
    { query: ' ' },
    { query: 'q'.repeat(257) },
    { query: 'grapple', system: ' ' },
    { query: 'grapple', extra: true },
  ])('rejects invalid direct input as InvalidParams: %j', async (input) => {
    await expect(handleLookupRule(input, inaccessibleClient())).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('retains the generation-module compatibility export', () => {
    expect(compatibilityHandler).toBe(handleLookupRule);
  });

  it('advertises strict input/output schemas and hides the tool in delegated discovery', async () => {
    const tool = getAllTools(false).find(({ name }) => name === 'lookup_rule');
    expect(tool).toBeDefined();
    expect(getAllTools(true).some(({ name }) => name === 'lookup_rule')).toBe(false);

    const result = await handleLookupRule({ query: 'grapple' }, inaccessibleClient());
    const ajv = new Ajv();
    const validateInput = ajv.compile(tool?.inputSchema ?? {});
    const validateOutput = ajv.compile(tool?.outputSchema ?? ruleLookupOutputJsonSchema);
    expect(validateInput({ query: 'grapple' })).toBe(true);
    expect(validateInput({ query: 'grapple', extra: true })).toBe(false);
    expect(validateOutput(result.structuredContent)).toBe(true);
    expect(validateOutput({ ...result.structuredContent, query: 'grapple' })).toBe(false);
  });
});

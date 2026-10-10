import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { DiagnosticSystem } from '../../utils/diagnostics.js';
import { routeToolRequest as routeNewToolRequest } from '../new-router.js';
import { routeToolRequest } from '../router.js';

function isolatedClient(): FoundryClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'isDelegatedMode') {
          return () => false;
        }
        throw new Error(`Unexpected Foundry access: ${String(property)}`);
      },
    },
  ) as FoundryClient;
}

for (const route of [routeToolRequest, routeNewToolRequest]) {
  describe(`${route === routeToolRequest ? 'primary' : 'registry fallback'} rule lookup routing`, () => {
    const diagnostics = {} as DiagnosticsClient;
    const system = {} as DiagnosticSystem;

    it('routes valid input without consulting Foundry', async () => {
      const result = await route(
        'lookup_rule',
        { query: 'grapple', system: 'dnd5e' },
        isolatedClient(),
        diagnostics,
        system,
      );
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 1,
        capability: { feature: 'rulesLookup', status: 'unavailable' },
      });
    });

    it.each([
      {},
      { query: '' },
      { query: ' ' },
      { query: 'q'.repeat(257) },
      { query: 'grapple', system: ' ' },
      { query: 'grapple', unknown: true },
    ])('rejects invalid input before handler or backend access: %j', async (input) => {
      await expect(
        route('lookup_rule', input, isolatedClient(), diagnostics, system),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    });
  });
}

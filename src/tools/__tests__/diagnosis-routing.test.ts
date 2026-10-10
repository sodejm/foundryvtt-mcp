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

function inaccessible<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`Unexpected ${label} access: ${String(property)}`);
      },
    },
  ) as T;
}

for (const route of [routeToolRequest, routeNewToolRequest]) {
  describe(`${route === routeToolRequest ? 'primary' : 'registry fallback'} diagnosis routing`, () => {
    const diagnostics = inaccessible<DiagnosticsClient>('diagnostics client');
    const system = inaccessible<DiagnosticSystem>('diagnostic system');

    it.each([
      {},
      { category: 'module error' },
      { category: 'unknown category' },
    ])('routes valid input without consulting a diagnostic or Foundry source: %j', async (input) => {
      const result = await route('diagnose_errors', input, isolatedClient(), diagnostics, system);
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 1,
        capability: { feature: 'diagnostics', status: 'unavailable' },
      });
    });

    it.each([
      { category: '' },
      { category: ' ' },
      { category: 'c'.repeat(129) },
      { category: 1 },
      { category: 'module', unknown: true },
    ])('rejects invalid input before handler or backend access: %j', async (input) => {
      await expect(
        route('diagnose_errors', input, isolatedClient(), diagnostics, system),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    });
  });
}

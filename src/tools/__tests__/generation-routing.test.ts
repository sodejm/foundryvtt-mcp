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
  describe(`${route === routeToolRequest ? 'primary' : 'registry fallback'} generation routing`, () => {
    const diagnostics = inaccessible<DiagnosticsClient>('diagnostics client');
    const system = inaccessible<DiagnosticSystem>('diagnostic system');

    it.each([
      ['generate_npc', {}, 'npc'],
      ['generate_npc', { level: 20, race: 'Sky Weaver', class: 'Memory Keeper' }, 'npc'],
      ['generate_loot', {}, 'loot'],
      ['generate_loot', { challengeRating: 2.5, treasureType: 'hoard' }, 'loot'],
    ] as const)('routes valid %s input without consulting a Foundry source: %j', async (name, input, outputKey) => {
      const result = await route(name, input, isolatedClient(), diagnostics, system);
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 1,
        preview: {
          mode: 'creative-preview',
          status: 'preview',
          persisted: false,
          rulesVerified: false,
        },
      });
      expect(result.structuredContent).toHaveProperty(outputKey);
    });

    it.each([
      ['generate_npc', { unknown: true }],
      ['generate_npc', { level: 0 }],
      ['generate_loot', { unknown: true }],
      ['generate_loot', { treasureType: 'cache' }],
    ] as const)('rejects invalid %s input before handler or backend access', async (name, input) => {
      await expect(route(name, input, isolatedClient(), diagnostics, system)).rejects.toMatchObject(
        {
          code: ErrorCode.InvalidParams,
        },
      );
    });
  });
}

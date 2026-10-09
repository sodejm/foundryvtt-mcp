import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { DiagnosticSystem } from '../../utils/diagnostics.js';
import { readMetadata } from '../handlers/__tests__/pagination-fixture.js';
import { routeToolRequest as routeNewToolRequest } from '../new-router.js';
import { routeToolRequest } from '../router.js';

for (const route of [routeToolRequest, routeNewToolRequest]) {
  describe(`${route === routeToolRequest ? 'primary' : 'registry fallback'} structured read routing`, () => {
    const diagnostics = {} as DiagnosticsClient;
    const system = {} as DiagnosticSystem;
    it('routes world item detail to the common validated handler', async () => {
      const item = { _id: 'Item000000000001', name: 'Twin', type: 'loot' };
      const getItem = vi.fn().mockResolvedValue(item);
      const client = { getItem, getReadMetadata: () => readMetadata() } as unknown as FoundryClient;
      const result = await route(
        'get_item_details',
        { itemId: item._id },
        client,
        diagnostics,
        system,
      );
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 3,
        documentType: 'Item',
        record: { id: item._id },
      });
      expect(getItem).toHaveBeenCalledWith(item._id);
    });
    for (const [tool, field] of [
      ['get_actor_details', 'actorId'],
      ['get_item_details', 'itemId'],
    ] as const) {
      it.each([
        {},
        { [field]: 42 },
        { [field]: '' },
        { [field]: '../escape' },
      ])(`rejects invalid ${tool} input before backend access: %j`, async (args) => {
        const getActor = vi.fn();
        const getItem = vi.fn();
        const client = { getActor, getItem } as unknown as FoundryClient;
        await expect(route(tool, args, client, diagnostics, system)).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
        });
        expect(getActor).not.toHaveBeenCalled();
        expect(getItem).not.toHaveBeenCalled();
      });
    }
  });
}

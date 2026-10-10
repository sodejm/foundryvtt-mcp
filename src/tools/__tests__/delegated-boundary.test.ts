import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
import { PaginationCursorError } from '../../foundry/pagination.js';
import type { DiagnosticSystem } from '../../utils/diagnostics.js';
import { logger } from '../../utils/logger.js';
import { delegatedTools, isDelegatedResource } from '../authorization.js';
import { getAllTools } from '../definitions.js';
import { paginationMetadata } from '../handlers/__tests__/pagination-fixture.js';
import { handleReadResource } from '../handlers/resources.js';
import { withToolError } from '../handlers/utils.js';
import {
  routeResourceRequest as routeNewResource,
  routeToolRequest as routeNewTool,
} from '../new-router.js';
import { toolRegistry } from '../registry.js';
import { getAllResources, getAllResourceTemplates } from '../resources.js';
import { routeResourceRequest, routeToolRequest } from '../router.js';

const diagnostics = {} as DiagnosticsClient;
const system = {} as DiagnosticSystem;
const delegated = (overrides: Record<string, unknown> = {}) =>
  ({
    isDelegatedMode: () => true,
    assertReadSurfaceAllowed: vi.fn(),
    ...overrides,
  }) as unknown as FoundryClient;

afterEach(() => vi.restoreAllMocks());

describe('delegated discovery', () => {
  it('advertises exactly the demonstrated read surfaces', () => {
    expect(
      getAllTools(true)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(Object.keys(delegatedTools).sort());
    expect(
      getAllResources(true)
        .map(({ uri }) => uri)
        .sort(),
    ).toEqual(['foundry://actors', 'foundry://items', 'foundry://journals', 'foundry://users']);
    expect(
      getAllResourceTemplates(true)
        .map(({ uriTemplate }) => uriTemplate)
        .sort(),
    ).toEqual([
      'foundry://actors{?limit,cursor}',
      'foundry://items{?limit,cursor}',
      'foundry://journals{?limit,cursor}',
      'foundry://users{?limit,cursor}',
    ]);
  });

  it('preserves service-identity discovery', () => {
    expect(getAllTools()).toEqual(getAllTools(false));
    expect(getAllTools().length).toBeGreaterThan(getAllTools(true).length);
    expect(getAllResources()).toHaveLength(9);
    expect(getAllResourceTemplates()).toHaveLength(5);
  });

  it.each([
    'invalid',
    'https://actors',
    'foundry://actors/private',
    'foundry://actors#private',
    'foundry://user@actors',
    'foundry://actors:123',
    'foundry://scenes',
  ])('does not advertise unsupported or ambiguous URI %s', (uri) => {
    expect(isDelegatedResource(uri)).toBe(false);
  });
});

for (const route of [routeToolRequest, routeNewTool]) {
  describe(`${route === routeToolRequest ? 'primary' : 'alternate'} delegated tool boundary`, () => {
    it.each([
      ...getAllTools()
        .filter(({ name }) => !Object.hasOwn(delegatedTools, name))
        .map(({ name }) => name),
      'unknown-private-tool',
      'constructor',
      '__proto__',
    ])('rejects %s before registry execution or logging arguments', async (name) => {
      const execute = vi.spyOn(toolRegistry, 'execute');
      const debug = vi.spyOn(logger, 'debug');
      const client = delegated();
      await expect(
        route(name, { secret: 'PRIVATE_VALUE' }, client, diagnostics, system),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      expect(execute).not.toHaveBeenCalled();
      expect(client.assertReadSurfaceAllowed).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    });

    it.each(
      Object.entries(delegatedTools),
    )('requires active authorization for %s (%s)', async (name, surface) => {
      const denial = new McpError(ErrorCode.InvalidRequest, 'Caller is not authorized');
      const execute = vi.spyOn(toolRegistry, 'execute');
      const client = delegated({
        assertReadSurfaceAllowed: vi.fn(() => {
          throw denial;
        }),
      });
      await expect(route(name, {}, client, diagnostics, system)).rejects.toBe(denial);
      expect(client.assertReadSurfaceAllowed).toHaveBeenCalledWith(surface);
      expect(execute).not.toHaveBeenCalled();
    });

    it('sanitizes unexpected registry errors without losing protocol errors', async () => {
      vi.spyOn(toolRegistry, 'has').mockReturnValue(true);
      const execute = vi
        .spyOn(toolRegistry, 'execute')
        .mockRejectedValue(new Error('PRIVATE_UUID PRIVATE_NAME'));
      await expect(route('search_actors', {}, delegated(), diagnostics, system)).rejects.toThrow(
        'Delegated read unavailable',
      );
      const denial = new McpError(ErrorCode.InvalidRequest, 'Caller is not authorized');
      execute.mockRejectedValue(denial);
      await expect(route('search_actors', {}, delegated(), diagnostics, system)).rejects.toBe(
        denial,
      );
    });
  });
}

for (const route of [routeResourceRequest, routeNewResource, handleReadResource]) {
  describe('delegated resource boundary', () => {
    it.each([
      'foundry://scenes',
      'foundry://scenes/current',
      'foundry://combat',
      'foundry://world/settings',
      'foundry://system/diagnostics',
      'foundry://actors/PRIVATE_ID',
    ])('rejects %s before collection access', async (uri) => {
      const getCollectionPage = vi.fn();
      const client = delegated({ getCollectionPage });
      await expect(route(uri, client, diagnostics)).rejects.toMatchObject({
        code: ErrorCode.InvalidRequest,
      });
      expect(getCollectionPage).not.toHaveBeenCalled();
    });

    it.each([
      '?userId=PRIVATE_ID',
      '?role=4',
      '?worldId=other',
      '?sessionId=other',
      '?limit=1&limit=2',
      '?cursor=one&cursor=two',
      '?limit=0',
      '?limit=101',
    ])('rejects forged or invalid collection parameters %s', async (query) => {
      const getCollectionPage = vi.fn();
      const client = delegated({ getCollectionPage });
      await expect(route(`foundry://journals${query}`, client, diagnostics)).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
      expect(getCollectionPage).not.toHaveBeenCalled();
    });

    it('returns only the authorized collection page and its scoped count', async () => {
      const getCollectionPage = vi.fn().mockResolvedValue({
        records: [{ id: 'Journal000000001', name: 'Visible', documentType: 'JournalEntry' }],
        ...paginationMetadata(1, 1, 1),
      });
      const result = await route(
        'foundry://journals?limit=1',
        delegated({ getCollectionPage }),
        diagnostics,
      );
      const page = JSON.parse(result.contents[0]?.text);
      expect(page).toMatchObject({
        schemaVersion: 3,
        total: 1,
        returnedCount: 1,
        complete: true,
        nextUri: null,
      });
      expect(page.records).toHaveLength(1);
      expect(getCollectionPage).toHaveBeenCalledWith('journals', { limit: 1 });
    });
  });
}

describe('delegated handler errors', () => {
  it.each([
    'different caller',
    'expired snapshot',
    'PRIVATE_WORLD',
  ])('uses one safe invalid-params error for unavailable cursors: %s', async (reason) => {
    await expect(
      withToolError(
        'read',
        async () => {
          throw new PaginationCursorError(reason);
        },
        delegated(),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Pagination cursor unavailable'),
    });
  });

  it('omits backend details from errors and logs', async () => {
    const errorLog = vi.spyOn(logger, 'error');
    await expect(
      withToolError(
        'private operation',
        async () => {
          throw new Error('PRIVATE_UUID PRIVATE_NAME');
        },
        delegated(),
      ),
    ).rejects.toThrow('Delegated read unavailable');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('Delegated read failed');
  });

  it('retains service-identity error details for existing deployments', async () => {
    await expect(
      withToolError('read', async () => {
        throw new Error('backend unavailable');
      }),
    ).rejects.toThrow('Failed to read: backend unavailable');
  });
});

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  Capability,
  CapabilityReport,
  CapabilityStatus,
} from '../../../foundry/capabilities.js';
import type { FoundryClient } from '../../../foundry/client.js';
import type { CompendiumSearchResult } from '../../../foundry/types.js';
import { handleGetCapabilities, handleSearchCompendium } from '../compendium.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

function capability(status: CapabilityStatus = 'available'): Capability {
  return {
    feature: 'compendiumSearch',
    status,
    reason: `Verified ${status}`,
    remediation: status === 'available' ? null : 'Check the local relay configuration.',
    verifiedAt: '2026-10-09T00:00:00.000Z',
    transport: 'rest',
  };
}
function success(): CompendiumSearchResult {
  return {
    schemaVersion: 1,
    capability: { ...capability(), status: 'available' },
    restAvailable: true,
    results: [
      {
        compendiumId: 'dnd5e.spells',
        itemId: 'abcdef0123456789',
        name: 'Divine Smite',
        type: 'spell',
        img: 'icons/svg/aura.svg',
        system: { level: 1, school: 'evo', source: { rules: '2014' } },
      },
    ],
    ...paginationMetadata(1, 1, 20),
    readMetadata: readMetadata({ source: 'rest', snapshotId: null, revision: 0 }),
  };
}
function mockClient(result: CompendiumSearchResult = success()): FoundryClient {
  return { searchCompendium: vi.fn(async () => result) } as unknown as FoundryClient;
}
function textOf(result: Awaited<ReturnType<typeof handleSearchCompendium>>) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('Compendium handlers', () => {
  it('returns matching text and structured identity, source, and capability metadata', async () => {
    const result = await handleSearchCompendium({ query: 'Divine Smite', limit: 20 }, mockClient());
    expect(result.structuredContent).toEqual(success());
    const text = textOf(result);
    for (const value of [
      'Compendium Search Results',
      'Divine Smite',
      'dnd5e.spells',
      'abcdef0123456789',
      'rules: 2014',
      '**Capability:** available',
      '**Limit:** 20',
    ]) {
      expect(text).toContain(value);
    }
  });
  it('passes all filters and pagination through to the client', async () => {
    const client = mockClient();
    const filters = {
      compendiumId: 'dnd5e.spells',
      packType: 'Item',
      itemType: 'spell',
      spellLevel: 1,
      source: '2014',
    };
    await handleSearchCompendium(
      { query: 'Divine Smite', filters, limit: 20, cursor: 'opaque-cursor' },
      client,
    );
    expect(client.searchCompendium).toHaveBeenCalledWith({
      query: 'Divine Smite',
      ...filters,
      limit: 20,
      cursor: 'opaque-cursor',
    });
  });
  it('permits an empty query to browse a pack, but requires the query field', async () => {
    const client = mockClient();
    await handleSearchCompendium({ query: '', filters: { compendiumId: 'dnd5e.spells' } }, client);
    expect(client.searchCompendium).toHaveBeenCalledWith({
      query: '',
      compendiumId: 'dnd5e.spells',
    });
    await expect(handleSearchCompendium({}, client)).rejects.toThrow(McpError);
  });
  it('reserves the empty-result message for a verified successful search', async () => {
    const result = success();
    if (!result.restAvailable) {
      throw new Error('Expected successful fixture');
    }
    const response = await handleSearchCompendium(
      { query: 'No match' },
      mockClient({ ...result, results: [], ...paginationMetadata(0, 0, 20) }),
    );
    expect(response.structuredContent).toMatchObject({
      restAvailable: true,
      results: [],
      total: 0,
      capability: { status: 'available' },
    });
    expect(textOf(response)).toContain('No compendium entries found');
  });
  it.each([
    'unavailable',
    'unauthorized',
    'unreachable',
    'incompatible',
  ] as const)('reports %s as an explicit failure with unknown results', async (status) => {
    const response = await handleSearchCompendium(
      { query: 'Divine Smite' },
      mockClient({
        schemaVersion: 1,
        restAvailable: false,
        capability: { ...capability(status), status },
        results: null,
        total: null,
        page: null,
        limit: 20,
        nextCursor: null,
      }),
    );
    expect(response.structuredContent).toMatchObject({
      restAvailable: false,
      results: null,
      total: null,
      page: null,
      capability: { status },
    });
    expect(textOf(response)).toContain(`Compendium search: ${status}`);
    expect(textOf(response)).toContain('Results are unavailable.');
    expect(textOf(response)).not.toContain('No compendium entries found');
  });
  it('renders the opaque next-page cursor', async () => {
    const response = await handleSearchCompendium(
      { query: 'Divine Smite' },
      mockClient({ ...success(), ...paginationMetadata(1, 40, 20) }),
    );
    expect(textOf(response)).toContain('Next cursor');
    expect(textOf(response)).toContain('fixture-cursor');
  });
  it.each([
    { query: 123 },
    { query: 'x', unknown: true },
    { query: 'x', limit: 0 },
    { query: 'x', limit: 101 },
    { query: 'x', filters: { unknown: true } },
    { query: 'x', filters: { itemType: 'spell,resultType:WorldEntity' } },
  ])('rejects invalid input without querying the client: %j', async (input) => {
    const client = mockClient();
    await expect(handleSearchCompendium(input, client)).rejects.toThrow(McpError);
    expect(client.searchCompendium).not.toHaveBeenCalled();
  });
  it('rejects a malformed success envelope instead of advertising it', async () => {
    const malformed = { ...success(), total: null } as unknown as CompendiumSearchResult;
    await expect(handleSearchCompendium({ query: 'x' }, mockClient(malformed))).rejects.toThrow();
  });
  it('propagates client errors through the tool error boundary', async () => {
    const client = {
      searchCompendium: vi.fn(async () => {
        throw new Error('Compendium pack not found');
      }),
    } as unknown as FoundryClient;
    await expect(handleSearchCompendium({ query: 'x' }, client)).rejects.toThrow();
  });
  it('reports each feature status and remediation consistently', async () => {
    const report: CapabilityReport = {
      schemaVersion: 1,
      capabilities: [
        capability(),
        ...(['rulesLookup', 'diagnostics', 'contentGeneration'] as const).map((feature) => ({
          ...capability('unavailable'),
          feature,
        })),
      ],
    };
    const client = { getCapabilities: vi.fn(async () => report) } as unknown as FoundryClient;
    const result = await handleGetCapabilities({}, client);
    expect(result.structuredContent).toEqual(report);
    for (const entry of report.capabilities) {
      expect(result.content[0].text).toContain(`${entry.feature}: ${entry.status}`);
    }
    await expect(handleGetCapabilities({ unknown: true }, client)).rejects.toThrow(McpError);
    expect(client.getCapabilities).toHaveBeenCalledTimes(1);
  });
});

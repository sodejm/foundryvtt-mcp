import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompendiumRestAdapter } from '../rest-compendium.js';

const axiosMocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: axiosMocks.create,
    isAxiosError: (value: unknown) =>
      typeof value === 'object' && value !== null && Reflect.get(value, 'isAxiosError') === true,
  },
}));

interface RequestConfig {
  params?: Record<string, unknown>;
}

function adapter(overrides: Partial<ConstructorParameters<typeof CompendiumRestAdapter>[0]> = {}) {
  return new CompendiumRestAdapter({
    baseUrl: 'https://relay.example.test/foundry',
    clientId: 'world-1',
    apiKey: 'api-secret',
    timeout: 3210,
    ...overrides,
  });
}

function searchRow(index: number, overrides: Record<string, unknown> = {}) {
  const id = `entry${index}`;
  const packageId = 'dnd5e.spells';
  return {
    documentType: 'Item',
    id,
    name: `Spell ${index}`,
    package: packageId,
    subType: 'spell',
    uuid: `Compendium.${packageId}.Item.${id}`,
    resultType: 'CompendiumEntity',
    icon: `icons/${index}.webp`,
    ...overrides,
  };
}

function searchEnvelope(results: unknown[]) {
  return { data: { type: 'search-result', results } };
}

function entityEnvelope(row: ReturnType<typeof searchRow>, data: Record<string, unknown> = {}) {
  return {
    data: {
      type: 'entity-result',
      uuid: row.uuid,
      data: {
        _id: row.id,
        name: row.name,
        type: row.subType,
        img: row.icon,
        ...data,
      },
    },
  };
}

function axiosError(status?: number, message = 'sensitive transport details') {
  return status === undefined
    ? { isAxiosError: true, message, code: 'ECONNREFUSED' }
    : { isAxiosError: true, message, response: { status, data: { error: message } } };
}

describe('CompendiumRestAdapter', () => {
  beforeEach(() => {
    axiosMocks.get.mockReset();
    axiosMocks.create.mockReset();
    axiosMocks.create.mockReturnValue({ get: axiosMocks.get });
  });

  it('reports missing or unsafe configuration as unavailable without making a request', async () => {
    for (const value of [
      new CompendiumRestAdapter({}),
      adapter({ baseUrl: 'ftp://relay.example.test' }),
      adapter({ baseUrl: 'https://user:pass@relay.example.test' }),
      adapter({ baseUrl: 'https://relay.example.test?key=secret' }),
      adapter({ baseUrl: 'https://relay.example.test/#fragment' }),
    ]) {
      await expect(value.probe()).resolves.toMatchObject({
        feature: 'compendiumSearch',
        status: 'unavailable',
        transport: 'rest',
      });
      await expect(value.search({ query: 'fire' })).resolves.toEqual(
        expect.objectContaining({
          capability: expect.objectContaining({ status: 'unavailable' }),
        }),
      );
    }
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it('probes authenticated search and entity reading with bounded transport settings', async () => {
    const row = searchRow(1);
    axiosMocks.get
      .mockResolvedValueOnce(searchEnvelope([row]))
      .mockResolvedValueOnce(entityEnvelope(row));
    const subject = adapter();

    await expect(subject.probe()).resolves.toMatchObject({
      feature: 'compendiumSearch',
      status: 'available',
      remediation: null,
      transport: 'rest',
    });
    expect(axiosMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://relay.example.test/foundry',
        headers: { 'x-api-key': 'api-secret' },
        timeout: 3210,
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
      }),
    );
    expect(axiosMocks.get).toHaveBeenCalledWith('/search', {
      params: expect.objectContaining({
        clientId: 'world-1',
        filter: 'resultType:CompendiumEntity',
        limit: 1,
        minified: false,
      }),
    });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'unavailable'],
    [503, 'unavailable'],
    [408, 'unreachable'],
    [504, 'unreachable'],
  ])('classifies HTTP %i as %s', async (status, expected) => {
    axiosMocks.get.mockRejectedValue(axiosError(status));
    await expect(adapter().probe()).resolves.toMatchObject({ status: expected });
  });

  it('classifies timeout and network failures as unreachable without leaking raw details', async () => {
    const raw = 'https://api-secret@private.example.test/internal';
    axiosMocks.get.mockRejectedValue(axiosError(undefined, raw));
    const result = await adapter().search({ query: 'fire' });

    expect(result.capability.status).toBe('unreachable');
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(JSON.stringify(result)).not.toContain('api-secret');
    expect(result).not.toHaveProperty('entries');
  });

  it('rejects malformed success and module error envelopes', async () => {
    axiosMocks.get
      .mockResolvedValueOnce({ data: { type: 'search-result' } })
      .mockResolvedValueOnce({
        data: { type: 'search-result', results: [], error: { message: 'module failure' } },
      });

    await expect(adapter().probe()).resolves.toMatchObject({ status: 'incompatible' });
    const result = await adapter().search({ query: 'fire' });
    expect(result.capability.status).toBe('incompatible');
    expect(JSON.stringify(result)).not.toContain('module failure');
    expect(result).not.toHaveProperty('entries');
  });

  it('returns a genuine empty result only after a successful search response', async () => {
    const row = searchRow(1);
    axiosMocks.get
      .mockResolvedValueOnce(searchEnvelope([]))
      .mockResolvedValueOnce(searchEnvelope([row]))
      .mockResolvedValueOnce(entityEnvelope(row));
    await expect(adapter().search({ query: 'nothing' })).resolves.toMatchObject({
      capability: { status: 'available', remediation: null },
      entries: [],
    });
  });

  it('reports an empty installation as unverified instead of claiming entity-read access', async () => {
    axiosMocks.get.mockResolvedValue(searchEnvelope([]));
    await expect(adapter().probe()).resolves.toMatchObject({ status: 'unavailable' });
    const result = await adapter().search({ query: '' });
    expect(result.capability.status).toBe('unavailable');
    expect(result).not.toHaveProperty('entries');
  });

  it.each([
    401, 403,
  ])('requires entity-read scope even when search succeeds (HTTP %i)', async (status) => {
    axiosMocks.get
      .mockResolvedValueOnce(searchEnvelope([searchRow(1)]))
      .mockRejectedValueOnce(axiosError(status, 'api-secret'));
    await expect(adapter().probe()).resolves.toMatchObject({ status: 'unauthorized' });
  });

  it('does not present empty results after the unfiltered verification loses authorization', async () => {
    axiosMocks.get.mockResolvedValueOnce(searchEnvelope([])).mockRejectedValueOnce(axiosError(403));
    const result = await adapter().search({ query: 'nothing' });
    expect(result.capability.status).toBe('unauthorized');
    expect(result).not.toHaveProperty('entries');
  });

  it.each([
    searchEnvelope([searchRow(1), searchRow(2)]),
    searchEnvelope([searchRow(1, { uuid: 'World.Item.secret' })]),
    searchEnvelope([searchRow(1, { resultType: 'WorldEntity' })]),
  ])('rejects invalid bounded probe rows', async (response) => {
    axiosMocks.get.mockResolvedValue(response);
    await expect(adapter().probe()).resolves.toMatchObject({ status: 'incompatible' });
  });

  it('supports untyped compendium documents without inventing a subtype', async () => {
    const row = searchRow(1, {
      documentType: 'JournalEntry',
      subType: '',
      uuid: 'Compendium.dnd5e.spells.JournalEntry.entry1',
    });
    axiosMocks.get
      .mockResolvedValueOnce(searchEnvelope([row]))
      .mockResolvedValueOnce(entityEnvelope(row, { type: undefined }));
    await expect(adapter().search({ query: '' })).resolves.toMatchObject({
      capability: { status: 'available' },
      entries: [{ type: 'JournalEntry' }],
    });
  });

  it('hydrates multiple results, deduplicates UUIDs, and applies exact local metadata filters', async () => {
    const row1 = searchRow(1);
    const row2 = searchRow(2, { name: 'Other Spell' });
    axiosMocks.get.mockImplementation(async (path: string, config: RequestConfig) => {
      if (path === '/search') {
        return searchEnvelope([row1, row1, row2]);
      }
      if (config.params?.uuid === row1.uuid) {
        return entityEnvelope(row1, {
          system: { level: 3, school: 'evo', source: { rules: '2014', custom: 'PHB' } },
        });
      }
      return entityEnvelope(row2, {
        system: { level: 5, school: 'abj', source: { rules: '2024' } },
      });
    });

    const result = await adapter().search({ spellLevel: 3, source: 'phb' });
    expect(result.capability.status).toBe('available');
    expect(result.entries).toEqual([
      {
        compendiumId: 'dnd5e.spells',
        itemId: 'entry1',
        name: 'Spell 1',
        type: 'spell',
        img: 'icons/1.webp',
        system: { level: 3, school: 'evo', source: { rules: '2014', custom: 'PHB' } },
      },
    ]);
    expect(axiosMocks.get).toHaveBeenCalledTimes(3);
  });

  it('sends documented server filters and rejects filter grammar injection locally', async () => {
    axiosMocks.get.mockResolvedValue(searchEnvelope([]));
    await adapter().search({
      query: 'shield',
      packType: 'Item',
      itemType: 'spell',
      compendiumId: 'dnd5e.spells',
    });
    expect(axiosMocks.get).toHaveBeenCalledWith('/search', {
      params: {
        clientId: 'world-1',
        query: 'shield',
        filter: 'resultType:CompendiumEntity,documentType:Item,subType:spell,package:dnd5e.spells',
        limit: 500,
        minified: false,
      },
    });

    axiosMocks.get.mockClear();
    for (const params of [
      { packType: 'Item,resultType:WorldEntity' },
      { itemType: 'spell:WorldEntity' },
      { compendiumId: 'dnd5e.spells\nresultType:WorldEntity' },
    ]) {
      await expect(adapter().search(params)).resolves.toEqual(
        expect.objectContaining({
          capability: expect.objectContaining({ status: 'incompatible' }),
        }),
      );
    }
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it('refuses a capped search because completeness cannot be established', async () => {
    axiosMocks.get.mockResolvedValue(
      searchEnvelope(Array.from({ length: 500 }, (_, index) => searchRow(index))),
    );
    const result = await adapter().search({ query: 'spell' });
    expect(result.capability).toMatchObject({ status: 'incompatible' });
    expect(result.capability.reason).toContain('narrow');
    expect(result).not.toHaveProperty('entries');
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched entity identity and safely omits malformed optional metadata', async () => {
    const row1 = searchRow(1);
    const row2 = searchRow(2);
    axiosMocks.get
      .mockResolvedValueOnce(searchEnvelope([row1]))
      .mockResolvedValueOnce(entityEnvelope(row1, { _id: 'different-id' }))
      .mockResolvedValueOnce(searchEnvelope([row2]))
      .mockResolvedValueOnce(
        entityEnvelope(row2, {
          img: 42,
          system: { level: 'third', school: {}, source: { rules: 2024, custom: '' } },
        }),
      );

    await expect(adapter().search({})).resolves.toEqual(
      expect.objectContaining({
        capability: expect.objectContaining({ status: 'incompatible' }),
      }),
    );
    await expect(adapter().search({})).resolves.toMatchObject({
      capability: { status: 'available' },
      entries: [
        {
          compendiumId: 'dnd5e.spells',
          itemId: 'entry2',
          name: 'Spell 2',
          type: 'spell',
        },
      ],
    });
  });

  it('bounds entity hydration concurrency', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => searchRow(index));
    let active = 0;
    let peak = 0;
    axiosMocks.get.mockImplementation(async (path: string, config: RequestConfig) => {
      if (path === '/search') {
        return searchEnvelope(rows);
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const row = rows.find((candidate) => candidate.uuid === config.params?.uuid);
      if (row === undefined) {
        throw new Error('test setup failed');
      }
      return entityEnvelope(row);
    });

    const result = await adapter().search({});
    expect(result.capability.status).toBe('available');
    expect(result.entries).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

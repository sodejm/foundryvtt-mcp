import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import type { Capability, CapabilityStatus } from './capabilities.js';
import type { CompendiumSearchParams } from './client.js';
import type { CompendiumSearchEntry } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_RESULT_LIMIT = 500;
const relayRequestQueues = new Map<string, Promise<void>>();

export interface CompendiumRestAdapterOptions {
  baseUrl?: string | undefined;
  clientId?: string | undefined;
  apiKey?: string | undefined;
  timeout?: number | undefined;
}

export interface CompendiumRestSearchResult {
  capability: Capability;
  entries?: CompendiumSearchEntry[];
}

interface SearchRow {
  documentType: string;
  id: string;
  name: string;
  package: string;
  subType: string;
  uuid: string;
  icon?: string;
}

interface AdapterConfig {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  timeout: number;
}

interface HydrationResult {
  capability?: Capability;
  entry?: CompendiumSearchEntry;
}

/**
 * Uses the authenticated Foundry REST relay for complete compendium discovery.
 * Every successful search row is hydrated through `/get` before being exposed.
 */
export class CompendiumRestAdapter {
  private readonly config: AdapterConfig | null;
  private readonly http: AxiosInstance | null;

  public constructor(options: CompendiumRestAdapterOptions) {
    this.config = normalizeConfig(options);
    this.http = this.config
      ? axios.create({
          baseURL: this.config.baseUrl,
          headers: { 'x-api-key': this.config.apiKey },
          timeout: this.config.timeout,
          maxRedirects: 0,
          maxContentLength: MAX_RESPONSE_BYTES,
          maxBodyLength: MAX_RESPONSE_BYTES,
          responseType: 'json',
        })
      : null;
  }

  public async probe(): Promise<Capability> {
    if (this.config === null || this.http === null) {
      return capability(
        'unavailable',
        'Compendium search is not configured.',
        'Configure the Foundry REST relay URL, client ID, and API key.',
      );
    }

    try {
      const response = await this.get('/search', {
        clientId: this.config.clientId,
        query: '',
        filter: 'resultType:CompendiumEntity',
        limit: 1,
        minified: false,
      });
      if (!isSearchEnvelope(response.data) || response.data.results.length > 1) {
        return incompatible('The Foundry REST relay returned an incompatible search response.');
      }
      if (response.data.results.length === 0) {
        return capability(
          'unavailable',
          'No compendium entry is available to verify authenticated entity reading.',
          'Create or import a compendium entry, then retry the capability check.',
        );
      }
      const row = parseSearchRow(response.data.results[0]);
      if (row === null) {
        return incompatible('The Foundry REST relay returned an invalid compendium search row.');
      }
      const hydrated = await this.hydrate(row);
      if (hydrated.capability !== undefined) {
        return hydrated.capability;
      }
      return capability('available', 'Compendium search was verified.', null);
    } catch (error: unknown) {
      return classifyFailure(error);
    }
  }

  public async search(params: CompendiumSearchParams): Promise<CompendiumRestSearchResult> {
    if (this.config === null || this.http === null) {
      return {
        capability: capability(
          'unavailable',
          'Compendium search is not configured.',
          'Configure the Foundry REST relay URL, client ID, and API key.',
        ),
      };
    }

    const invalid = validateSearchParams(params);
    if (invalid !== null) {
      return { capability: incompatible(invalid) };
    }

    const filters = ['resultType:CompendiumEntity'];
    if (params.packType !== undefined) {
      filters.push(`documentType:${params.packType}`);
    }
    if (params.itemType !== undefined) {
      filters.push(`subType:${params.itemType}`);
    }
    if (params.compendiumId !== undefined) {
      filters.push(`package:${params.compendiumId}`);
    }

    let rows: SearchRow[];
    try {
      const response = await this.get('/search', {
        clientId: this.config.clientId,
        query: params.query ?? '',
        filter: filters.join(','),
        limit: SEARCH_RESULT_LIMIT,
        minified: false,
      });
      if (!isSearchEnvelope(response.data)) {
        return {
          capability: incompatible(
            'The Foundry REST relay returned an incompatible search response.',
          ),
        };
      }

      rows = [];
      for (const value of response.data.results) {
        const row = parseSearchRow(value);
        if (row === null) {
          return {
            capability: incompatible(
              'The Foundry REST relay returned an invalid compendium search row.',
            ),
          };
        }
        rows.push(row);
      }
    } catch (error: unknown) {
      return { capability: classifyFailure(error) };
    }

    if (rows.length >= SEARCH_RESULT_LIMIT) {
      return {
        capability: incompatible(
          'The compendium search reached the relay result limit; narrow the search to verify a complete result set.',
          'Add a query or compendium filter and try again.',
        ),
      };
    }
    if (rows.length === 0) {
      const verified = await this.probe();
      return verified.status === 'available'
        ? { capability: verified, entries: [] }
        : { capability: verified };
    }

    const uniqueRows: SearchRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.uuid)) {
        seen.add(row.uuid);
        uniqueRows.push(row);
      }
    }

    const entries: CompendiumSearchEntry[] = [];
    for (const row of uniqueRows) {
      const result = await this.hydrate(row);
      if (result.capability !== undefined) {
        return { capability: result.capability };
      }
      if (result.entry !== undefined && matchesLocalFilters(result.entry, params)) {
        entries.push(result.entry);
      }
    }
    return {
      capability: capability('available', 'Compendium search was verified.', null),
      entries,
    };
  }

  private async get(
    path: string,
    params: Record<string, string | number | boolean>,
  ): Promise<AxiosResponse<unknown>> {
    const config = this.config;
    const http = this.http;
    if (config === null || http === null) {
      throw new Error('Compendium REST transport is not configured.');
    }
    return serializeRelayRequest(config.baseUrl, () => http.get<unknown>(path, { params }));
  }

  private async hydrate(row: SearchRow): Promise<HydrationResult> {
    if (this.config === null || this.http === null) {
      return {
        capability: capability(
          'unavailable',
          'Compendium search is not configured.',
          'Configure the Foundry REST relay URL, client ID, and API key.',
        ),
      };
    }

    try {
      const response = await this.get('/get', {
        clientId: this.config.clientId,
        uuid: row.uuid,
      });
      const data = parseEntityEnvelope(response.data, row);
      if (data === null) {
        return {
          capability: incompatible(
            'The Foundry REST relay returned an incompatible compendium entity response.',
          ),
        };
      }
      return { entry: projectEntry(row, data) };
    } catch (error: unknown) {
      return { capability: classifyFailure(error) };
    }
  }
}

function normalizeConfig(options: CompendiumRestAdapterOptions): AdapterConfig | null {
  const baseUrl = options.baseUrl?.trim();
  const clientId = options.clientId?.trim();
  const apiKey = options.apiKey?.trim();
  if (!baseUrl || !clientId || !apiKey) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return null;
  }

  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    clientId,
    apiKey,
    timeout,
  };
}

function validateSearchParams(params: CompendiumSearchParams): string | null {
  for (const [name, value] of [
    ['pack type', params.packType],
    ['item type', params.itemType],
    ['compendium ID', params.compendiumId],
  ] as const) {
    if (value !== undefined && (value.trim() === '' || /[:,\r\n]/.test(value))) {
      return `The ${name} filter contains unsupported characters.`;
    }
  }
  if (
    params.spellLevel !== undefined &&
    (!Number.isInteger(params.spellLevel) || params.spellLevel < 0)
  ) {
    return 'The spell level filter must be a non-negative integer.';
  }
  if (params.source !== undefined && params.source.trim() === '') {
    return 'The source filter must not be empty.';
  }
  return null;
}

function capability(
  status: CapabilityStatus,
  reason: string,
  remediation: string | null,
): Capability {
  return {
    feature: 'compendiumSearch',
    status,
    reason,
    remediation,
    verifiedAt: new Date().toISOString(),
    transport: 'rest',
  };
}

function incompatible(
  reason: string,
  remediation = 'Check the REST module and relay versions.',
): Capability {
  return capability('incompatible', reason, remediation);
}

function classifyFailure(error: unknown): Capability {
  if (!axios.isAxiosError(error)) {
    return incompatible('The Foundry REST relay returned an unexpected failure.');
  }
  const status = error.response?.status;
  if (status === 401 || status === 403) {
    return capability(
      'unauthorized',
      'The Foundry REST relay rejected the configured credentials.',
      'Verify the API key and its search and entity-read scopes.',
    );
  }
  if (status === 429) {
    return capability(
      'unavailable',
      'The Foundry REST relay rate limit was reached.',
      'Wait for the relay request quota to reset, then retry.',
    );
  }
  if (status === 404 || status === 502 || status === 503) {
    return capability(
      'unavailable',
      'No compatible Foundry REST module is currently available.',
      'Connect the configured Foundry client and verify that the REST module is enabled.',
    );
  }
  if (
    status === 408 ||
    status === 504 ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ETIMEDOUT'
  ) {
    return capability(
      'unreachable',
      'The Foundry REST relay timed out.',
      'Check relay and Foundry connectivity, then try again.',
    );
  }
  if (error.response === undefined) {
    return capability(
      'unreachable',
      'The Foundry REST relay could not be reached.',
      'Verify the relay address and network connectivity.',
    );
  }
  return incompatible('The Foundry REST relay rejected the capability request.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isSearchEnvelope(value: unknown): value is { results: unknown[] } {
  return (
    isRecord(value) &&
    value.type === 'search-result' &&
    !('error' in value) &&
    Array.isArray(value.results)
  );
}

function parseSearchRow(value: unknown): SearchRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const { documentType, id, name, package: packageId, subType, uuid, resultType, icon } = value;
  if (
    !nonEmptyString(documentType) ||
    !nonEmptyString(id) ||
    !nonEmptyString(name) ||
    !nonEmptyString(packageId) ||
    typeof subType !== 'string' ||
    !nonEmptyString(uuid) ||
    resultType !== 'CompendiumEntity' ||
    (icon !== undefined && typeof icon !== 'string')
  ) {
    return null;
  }
  const expectedUuid = `Compendium.${packageId}.${documentType}.${id}`;
  if (uuid !== expectedUuid) {
    return null;
  }
  return icon === undefined
    ? { documentType, id, name, package: packageId, subType, uuid }
    : { documentType, id, name, package: packageId, subType, uuid, icon };
}

function parseEntityEnvelope(value: unknown, row: SearchRow): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    value.type !== 'entity-result' ||
    value.uuid !== row.uuid ||
    'error' in value ||
    !isRecord(value.data)
  ) {
    return null;
  }
  const id = value.data._id ?? value.data.id;
  if (
    id !== row.id ||
    value.data.name !== row.name ||
    (row.subType !== ''
      ? value.data.type !== row.subType
      : value.data.type !== undefined && value.data.type !== '') ||
    !nonEmptyString(value.data.name) ||
    (value.data.type !== undefined && typeof value.data.type !== 'string')
  ) {
    return null;
  }
  return value.data;
}

function projectEntry(row: SearchRow, data: Record<string, unknown>): CompendiumSearchEntry {
  const entry: CompendiumSearchEntry = {
    compendiumId: row.package,
    itemId: row.id,
    name: data.name as string,
    type: row.subType || row.documentType,
  };
  if (nonEmptyString(data.img)) {
    entry.img = data.img;
  }

  if (isRecord(data.system)) {
    const system: NonNullable<CompendiumSearchEntry['system']> = {};
    if (
      typeof data.system.level === 'number' &&
      Number.isInteger(data.system.level) &&
      data.system.level >= 0
    ) {
      system.level = data.system.level;
    }
    if (nonEmptyString(data.system.school)) {
      system.school = data.system.school;
    }
    if (isRecord(data.system.source)) {
      const source: NonNullable<NonNullable<CompendiumSearchEntry['system']>['source']> = {};
      if (nonEmptyString(data.system.source.rules)) {
        source.rules = data.system.source.rules;
      }
      if (nonEmptyString(data.system.source.custom)) {
        source.custom = data.system.source.custom;
      }
      if (Object.keys(source).length > 0) {
        system.source = source;
      }
    }
    if (Object.keys(system).length > 0) {
      entry.system = system;
    }
  }
  return entry;
}

function matchesLocalFilters(
  entry: CompendiumSearchEntry,
  params: CompendiumSearchParams,
): boolean {
  if (params.spellLevel !== undefined && entry.system?.level !== params.spellLevel) {
    return false;
  }
  if (params.source !== undefined) {
    const expected = params.source.trim().toLowerCase();
    const source = entry.system?.source;
    if (
      source === undefined ||
      ![source.rules, source.custom].some((value) => value?.trim().toLowerCase() === expected)
    ) {
      return false;
    }
  }
  return true;
}

async function serializeRelayRequest<T>(baseUrl: string, request: () => Promise<T>): Promise<T> {
  const origin = new URL(baseUrl).origin;
  const prior = relayRequestQueues.get(origin) ?? Promise.resolve();
  const result = prior.then(async () => {
    try {
      return await request();
    } finally {
      // Relay 3.4.1 uses type + millisecond HTTP request IDs. Avoid collisions
      // across adapters on the same relay, including immediately completed calls.
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  });
  const settled = result.then(
    () => {},
    () => {},
  );
  relayRequestQueues.set(origin, settled);
  try {
    return await result;
  } finally {
    if (relayRequestQueues.get(origin) === settled) {
      relayRequestQueues.delete(origin);
    }
  }
}

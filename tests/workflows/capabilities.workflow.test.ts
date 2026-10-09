/** Built MCP process against the authenticated relay contract and failure matrix. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesReportSchema, compendiumSearchSchema } from '../../src/foundry/compendium-contract.js';

type Fault = 'none' | '401' | '403' | '404' | '503' | 'timeout' | 'malformed-search' | 'malformed-get' | 'read-denied';
const key = 'workflow-relay-key-secret';
const clientId = 'workflow-client';

describe('built MCP optional capability workflow', () => {
  let server: Server;
  let client: Client;
  let socketOnly: Client;
  let temporaryCwd: string;
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });
  let fault: Fault = 'none';
  let count = 3;
  let requests: string[] = [];
  let port: number;

  beforeEach(() => { fault = 'none'; count = 3; requests = []; });
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/status') { response.end('{"connected":true}'); return; }
      // Compatibility fixtures prove the existing log/health handlers still read
      // their own source; they are not a verified Foundry diagnosis provider.
      if (url.pathname.startsWith('/api/diagnostics/')) {
        if (request.headers['x-api-key'] !== 'legacy-core-key') {
          response.writeHead(401).end('{}'); return;
        }
        const logs = [
          { timestamp: '2026-10-09T10:00:00.000Z', level: 'error', message: 'Old fixture error', source: 'module' },
          { timestamp: '2026-10-09T11:00:00.000Z', level: 'info', message: 'Fixture startup', source: 'foundry' },
          { timestamp: '2026-10-09T12:00:00.000Z', level: 'error', message: 'Fixture TypeError first', source: 'module' },
          { timestamp: '2026-10-09T12:01:00.000Z', level: 'error', message: 'Fixture TypeError second', source: 'module' },
        ];
        if (url.pathname === '/api/diagnostics/logs') {
          expect(url.search).toBe('');
          response.end(JSON.stringify({ logs, total: logs.length })); return;
        }
        if (url.pathname === '/api/diagnostics/search') {
          expect(url.searchParams.get('pattern')).toBe('TypeError');
          expect(url.searchParams.get('level')).toBe('error');
          response.end(JSON.stringify({ logs: logs.slice(2), matches: 2,
            pattern: 'TypeError', searchTimeframe: 'fixture window' })); return;
        }
        if (url.pathname === '/api/diagnostics/health') {
          response.end(JSON.stringify({ timestamp: '2026-10-09T12:02:00.000Z', status: 'warning',
            server: { foundryVersion: 'fixture-version', systemVersion: 'fixture-system', worldId: 'fixture-world', uptime: 3661 },
            users: { total: 5, active: 3, gm: 1 }, modules: { total: 7, active: 4 },
            performance: { connectedClients: 3, memory: { rss: 10485760, heapTotal: 8388608,
              heapUsed: 4194304, external: 0, arrayBuffers: 0 } },
            logs: { bufferSize: 4, recentErrors: 3, recentWarnings: 1, errorRate: 75 },
          })); return;
        }
        response.writeHead(404).end('{}'); return;
      }
      if (!['/search', '/get'].includes(url.pathname)) { response.writeHead(404).end('{}'); return; }
      if (request.headers['x-api-key'] !== key || url.searchParams.get('clientId') !== clientId) {
        response.writeHead(401).end('{"error":"invalid fixture authorization"}'); return;
      }
      if (fault === 'timeout') return;
      if (['401', '403', '404', '503'].includes(fault) || (fault === 'read-denied' && url.pathname === '/get')) {
        response.writeHead(fault === 'read-denied' ? 403 : Number(fault)).end(JSON.stringify({
          error: `Bearer ${key} https://secret@example.com/private?token=hidden`,
        })); return;
      }
      if ((fault === 'malformed-search' && url.pathname === '/search') || (fault === 'malformed-get' && url.pathname === '/get')) {
        response.end(JSON.stringify({ key, type: 'wrong', results: [] })); return;
      }
      const rows = Array.from({ length: count }, (_, index) => ({
        documentType: 'Item', id: String(index).padStart(16, '0'), name: 'Duplicate Spell',
        package: 'world.fixture', subType: 'spell', resultType: 'CompendiumEntity',
        uuid: `Compendium.world.fixture.Item.${String(index).padStart(16, '0')}`,
      }));
      if (url.pathname === '/search') {
        expect(url.searchParams.get('filter')).toContain('resultType:CompendiumEntity');
        expect(url.searchParams.get('minified')).toBe('false');
        response.end(JSON.stringify({ type: 'search-result', results: url.searchParams.get('query') === 'absent'
          ? [] : rows.slice(0, Number(url.searchParams.get('limit'))) })); return;
      }
      const row = rows.find(row => row.uuid === url.searchParams.get('uuid'));
      response.end(JSON.stringify({ type: 'entity-result', uuid: row?.uuid,
        data: { _id: row?.id, name: row?.name, type: 'spell',
          system: { level: Number(row?.id) % 2, source: { rules: '2024', custom: 'Fixture' } } } }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    port = address.port;
    temporaryCwd = await mkdtemp(join(tmpdir(), 'foundry-capabilities-workflow-'));
    async function connect(rest: boolean) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], cwd: temporaryCwd, stderr: 'pipe',
        env: { NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: `http://127.0.0.1:${port}`,
          FOUNDRY_API_KEY: 'legacy-core-key', FOUNDRY_TIMEOUT: '200', FOUNDRY_RETRY_ATTEMPTS: '0',
          ...(rest && { FOUNDRY_REST_URL: `http://127.0.0.1:${port}`, FOUNDRY_REST_API_KEY: key, FOUNDRY_REST_CLIENT_ID: clientId }) },
      });
      transports.push(transport); transport.stderr?.on('data', () => {});
      const mcp = new Client({ name: 'capability-workflow', version: '1.0.0' });
      await mcp.connect(transport);
      for (const tool of (await mcp.listTools()).tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
      return mcp;
    }
    client = await connect(true); socketOnly = await connect(false);
  });
  afterAll(async () => {
    await Promise.allSettled([client?.close(), socketOnly?.close(), ...transports.map(t => t.close())]);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (temporaryCwd) await rm(temporaryCwd, { recursive: true, force: true });
  });
  async function call(name: string, args: Record<string, unknown>, mcp = client) {
    const result = CallToolResultSchema.parse(await mcp.callTool({ name, arguments: args }));
    const schema = schemas.get(name);
    expect(schema).toBeDefined();
    expect(ajv.validate(schema!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
    expect(JSON.stringify(result)).not.toContain('token=hidden');
    return { result, text };
  }
  async function search(args: Record<string, unknown>, mcp = client) {
    const { result, text } = await call('search_compendium', args, mcp);
    const page = compendiumSearchSchema.parse(result.structuredContent);
    expect(text).toContain(page.capability.status);
    return { page, text };
  }
  async function rule(args: Record<string, unknown>, mcp = client) {
    const { result, text } = await call('lookup_rule', args, mcp);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(Object.keys(result.structuredContent!).sort()).toEqual(['capability', 'schemaVersion']);
    expect(result.structuredContent).toMatchObject({ schemaVersion: 1, capability: {
      feature: 'rulesLookup', status: 'unavailable', reason: expect.any(String), remediation: expect.any(String),
    } });
    const capability = result.structuredContent!.capability as Record<string, unknown>;
    expect(Object.keys(capability).sort()).toEqual(['feature', 'reason', 'remediation', 'status']);
    expect(String(capability.reason).length).toBeGreaterThan(0);
    expect(String(capability.remediation).length).toBeGreaterThan(0);
    expect(text).not.toContain('Core Rulebook');
    return capability;
  }
  async function diagnosis(args: Record<string, unknown>, mcp = client) {
    const { result, text } = await call('diagnose_errors', args, mcp);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(Object.keys(result.structuredContent!).sort()).toEqual(['capability', 'schemaVersion']);
    expect(result.structuredContent).toMatchObject({ schemaVersion: 1, capability: {
      feature: 'diagnostics', status: 'unavailable', reason: expect.any(String), remediation: expect.any(String),
    } });
    const capability = result.structuredContent!.capability as Record<string, unknown>;
    expect(Object.keys(capability).sort()).toEqual(['feature', 'reason', 'remediation', 'status']);
    expect(String(capability.reason).length).toBeGreaterThan(0);
    expect(String(capability.remediation).length).toBeGreaterThan(0);
    for (const fabricated of ['Operational', 'healthy', 'totalErrors', 'healthScore', 'suggestions', 'evidence']) {
      expect(text).not.toContain(fabricated);
    }
    if (args.category) expect(text).not.toContain(args.category);
    return capability;
  }
  it.each([
    {}, { category: 'all' }, { category: 'connectivity' }, { category: 'authentication' },
    { category: 'unknown-category' }, { category: '模块 😀' },
    { category: '<script>SECRET_DIAGNOSIS_CATEGORY</script>' }, { category: 'x'.repeat(128) },
  ])('reports unavailable diagnosis without source access or category echo: %j', async args => {
    await diagnosis(args);
    expect(requests).toEqual([]);
  });
  it.each([false, true])('agrees with diagnosis capability discovery with REST configured=%s', async rest => {
    const mcp = rest ? client : socketOnly;
    const capability = await diagnosis({}, mcp);
    expect(requests).toEqual([]);
    const { result } = await call('get_capabilities', {}, mcp);
    const report = capabilitiesReportSchema.parse(result.structuredContent);
    expect(report.capabilities.find(cap => cap.feature === 'diagnostics')).toMatchObject(capability);
    if (rest) expect(report.capabilities[0]?.status).toBe('available');
    expect(requests).toEqual(rest ? ['/search', '/get'] : []);
  });
  it.each(['401', '403', '404', '503', 'timeout', 'malformed-search', 'malformed-get', 'read-denied'] as const)
    ('keeps diagnosis unavailable without probing a %s source', async mode => {
      fault = mode;
      await diagnosis({ category: 'connectivity' });
      expect(requests).toEqual([]);
    });
  it.each([
    { category: '' }, { category: ' \n\t' }, { category: false }, { category: 1 },
    { category: null }, { category: [] }, { category: {} }, { category: 'x'.repeat(129) },
    { category: 'all', extra: true }, { timeframe: 3600 }, { since: '2026-10-09T00:00:00Z' }, { limit: 1 },
  ])('rejects invalid or unsupported diagnosis input before source access: %j', async args => {
    await expect(client.callTool({ name: 'diagnose_errors', arguments: args }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(requests).toEqual([]);
  });
  it('preserves source-backed recent-log filters without feeding them into diagnosis', async () => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_recent_logs', arguments: {
      level: 'ERROR', since: '2026-10-09T11:59:00Z', limit: 1,
    } }));
    const text = JSON.stringify(result);
    expect(text).toContain('Fixture TypeError first');
    for (const excluded of ['Old fixture error', 'Fixture startup', 'Fixture TypeError second']) expect(text).not.toContain(excluded);
    expect(requests).toEqual(['/api/diagnostics/logs']);
    await diagnosis({ category: 'module' });
    expect(requests).toEqual(['/api/diagnostics/logs']);
  });
  it('preserves log search arguments, upstream count and rendered limit', async () => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'search_logs', arguments: {
      query: 'TypeError', level: 'ERROR', limit: 1,
    } }));
    const text = JSON.stringify(result);
    expect(text).toContain('Fixture TypeError first');
    expect(text).not.toContain('Fixture TypeError second');
    expect(text).toContain('**Matches:** 2');
    expect(text).toContain('**Showing:** 1');
    expect(requests).toEqual(['/api/diagnostics/search']);
  });
  it('preserves warning health and supplied metrics without inventing a diagnosis', async () => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_system_health', arguments: {} }));
    const text = JSON.stringify(result);
    for (const expected of ['**Overall Status:** warning', 'fixture-version', 'fixture-world', '1h 1m',
      '3 active / 5 total (1 GM)', '4 active / 7 installed', '4 MB used / 8 MB total', '10 MB',
      '**Recent Errors:** 3', '**Recent Warnings:** 1', '**Error Rate:** 75%']) expect(text).toContain(expected);
    expect(requests).toEqual(['/api/diagnostics/health']);
    await diagnosis({ category: 'performance' });
    expect(requests).toEqual(['/api/diagnostics/health']);
  });
  it.each([
    { query: 'Opportunity attack' },
    { query: 'Duplicate Spell', system: 'dnd5e' },
    { query: 'MCP absent rule 72f53a', system: 'not-an-installed-system@999' },
    { query: '规则 😀', system: '自定义' },
    { query: '<script>SECRET_RULE_QUERY</script>' },
    { query: 'x'.repeat(256), system: 's'.repeat(128) },
  ])('reports unsupported rules without retrieval or query echo: %j', async args => {
    const capability = await rule(args);
    expect(JSON.stringify(capability)).not.toContain(args.query);
    expect(requests).toEqual([]);
  });
  it('keeps rule availability consistent when authenticated compendium reads are available', async () => {
    const capability = await rule({ query: 'Duplicate Spell' });
    expect(requests).toEqual([]);
    const { result } = await call('get_capabilities', {});
    const report = capabilitiesReportSchema.parse(result.structuredContent);
    expect(report.capabilities[0]?.status).toBe('available');
    expect(report.capabilities.find(cap => cap.feature === 'rulesLookup')).toMatchObject(capability);
    expect(requests).toEqual(['/search', '/get']);
  });
  it('reports unavailable rules without optional REST configuration', async () => {
    const capability = await rule({ query: 'Opportunity attack' }, socketOnly);
    const { result } = await call('get_capabilities', {}, socketOnly);
    expect(capabilitiesReportSchema.parse(result.structuredContent).capabilities.find(cap => cap.feature === 'rulesLookup'))
      .toMatchObject(capability);
    expect(requests).toEqual([]);
  });
  it.each(['401', '403', '404', '503', 'timeout', 'malformed-search', 'malformed-get', 'read-denied'] as const)
    ('does not probe optional sources for unsupported rules during %s', async mode => {
      fault = mode;
      await rule({ query: 'Duplicate Spell', system: 'dnd5e@6.0.6' });
      expect(requests).toEqual([]);
    });
  it.each([
    {}, { query: '' }, { query: ' \n\t' }, { query: 1 }, { query: null }, { query: [] },
    { query: 'x'.repeat(257) }, { query: 'valid', system: '' }, { query: 'valid', system: '\t' },
    { query: 'valid', system: 1 }, { query: 'valid', system: null },
    { query: 'valid', system: 's'.repeat(129) }, { query: 'valid', extra: true },
    { query: 'valid', limit: 1 }, { query: 'valid', source: 'invented-source' },
  ])('rejects invalid rule input before source access: %j', async args => {
    await expect(client.callTool({ name: 'lookup_rule', arguments: args }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(requests).toEqual([]);
  });
  it('requires relay search and entity reads and keeps unsupported features unavailable', async () => {
    const { result, text } = await call('get_capabilities', {});
    const report = capabilitiesReportSchema.parse(result.structuredContent);
    expect(report.capabilities.map(cap => cap.status)).toEqual(['available', 'unavailable', 'unavailable', 'unavailable']);
    expect(requests).toEqual(['/search', '/get']);
    for (const cap of report.capabilities) expect(text).toContain(`${cap.feature}: ${cap.status}`);
  });
  it('does not infer relay capability from a working core status or legacy API key', async () => {
    const { page, text } = await search({ query: '' }, socketOnly);
    expect(page).toMatchObject({ restAvailable: false, results: null, total: null, capability: { status: 'unavailable' } });
    expect(text).not.toContain('No compendium entries found');
    expect(requests).toEqual([]);
  });
  it.each([
    ['401', 'unauthorized'], ['403', 'unauthorized'], ['read-denied', 'unauthorized'],
    ['404', 'unavailable'], ['503', 'unavailable'], ['timeout', 'unreachable'],
    ['malformed-search', 'incompatible'], ['malformed-get', 'incompatible'],
  ] as const)('returns explicit %s failure and recovers without cached availability', async (mode, status) => {
    expect((await search({ query: '' })).page.restAvailable).toBe(true);
    fault = mode;
    const { page, text } = await search({ query: '' });
    expect(page).toMatchObject({ results: null, total: null, page: null, nextCursor: null, capability: { status } });
    expect(text).not.toContain('No compendium entries found');
    const { result } = await call('get_capabilities', {});
    expect(capabilitiesReportSchema.parse(result.structuredContent).capabilities[0]?.status).toBe(status);
    fault = 'none';
    expect((await search({ query: '' })).page.restAvailable).toBe(true);
  });
  it('verifies an empty query result with an unfiltered search and entity read', async () => {
    const { page, text } = await search({ query: 'absent' });
    expect(page).toMatchObject({ restAvailable: true, results: [], total: 0, complete: true });
    expect(requests).toEqual(['/search', '/search', '/get']);
    expect(text).toContain('No compendium entries found');
  });
  it('does not claim availability on an installation with no verifiable entries', async () => {
    count = 0;
    expect((await search({ query: '' })).page).toMatchObject({ results: null, capability: { status: 'unavailable' } });
  });
  it.each([1, 100, 101, 251])('traverses %i entries with immutable bounded cursors', async size => {
    count = size;
    const args = { query: '', limit: 100 };
    let { page } = await search(args);
    if (!page.restAvailable) throw new Error('Expected available fixture');
    const snapshot = page.snapshotId;
    const ids = page.results.map(row => row.itemId);
    const first = page;
    while (page.nextCursor) {
      ({ page } = await search({ ...args, cursor: page.nextCursor }));
      if (!page.restAvailable) throw new Error('Expected continuation');
      expect(page.snapshotId).toBe(snapshot); ids.push(...page.results.map(row => row.itemId));
    }
    expect(ids).toEqual(Array.from({ length: size }, (_, i) => String(i).padStart(16, '0')));
    expect(new Set(ids).size).toBe(size);
    if (first.nextCursor) {
      await expect(client.callTool({ name: 'search_compendium', arguments: { ...args, query: 'changed', cursor: first.nextCursor } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });
  it('invalidates a cursor after permission loss and rejects it after recovery', async () => {
    count = 101;
    const args = { query: '', limit: 100 };
    const { page } = await search(args);
    expect(page.nextCursor).toBeTruthy();
    fault = '403';
    expect((await search({ ...args, cursor: page.nextCursor })).page.restAvailable).toBe(false);
    fault = 'none';
    await expect(client.callTool({ name: 'search_compendium', arguments: { ...args, cursor: page.nextCursor } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
  it('filters hydrated spell metadata and preserves pack identities', async () => {
    count = 5;
    const { page } = await search({ query: '', filters: { compendiumId: 'world.fixture', packType: 'Item', itemType: 'spell', spellLevel: 1, source: '2024' } });
    expect(page).toMatchObject({ restAvailable: true, total: 2 });
    if (page.restAvailable) expect(page.results.map(row => row.compendiumId)).toEqual(['world.fixture', 'world.fixture']);
  });
  it.each([{ query: '', limit: 101 }, { query: '', filters: { packType: 'Item,foo:bar' } }, { query: '', cursor: '' }, { query: '', extra: true }])('rejects invalid input before relay requests: %j', async args => {
    await expect(client.callTool({ name: 'search_compendium', arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(requests).toEqual([]);
  });
});

/** Built MCP server against a real paired relay and disposable Foundry world. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { capabilitiesReportSchema, compendiumSearchSchema } from '../../src/foundry/compendium-contract.js';

const fixturesSchema = z.object({
  apiKey: z.string().min(1), apiKeyId: z.union([z.string(), z.number()]),
  searchOnlyKey: z.string().min(1), sessionToken: z.string().min(1), clientId: z.string().min(1),
});
const pack = 'world.mcp-capability-fixtures';

describe('live optional REST capabilities through built MCP stdio', () => {
  let auth: z.infer<typeof fixturesSchema>;
  let relay: string;
  let controlUrl: string;
  let cwd: string;
  let good: Client;
  let socket: Client;
  let wrongKey: Client;
  let searchOnly: Client;
  let plainFoundry: Client;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  async function control(path: string, method = 'POST') {
    const response = await fetch(controlUrl + path, { method, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Test-world control ${path} failed (${response.status})`);
    return response.json();
  }
  async function keyEnabled(enabled: boolean) {
    const response = await fetch(`${relay}/auth/api-keys/${auth.apiKeyId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.sessionToken}` },
      body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Test-key update failed (${response.status})`);
  }
  async function connect(restUrl?: string, key?: string) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd, stderr: 'pipe', env: {
        NODE_ENV: 'test', LOG_LEVEL: 'error',
        FOUNDRY_URL: process.env.FOUNDRY_URL!,
        FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME!, FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
        FOUNDRY_TIMEOUT: '5000', FOUNDRY_RETRY_ATTEMPTS: '0',
        ...(restUrl && { FOUNDRY_REST_URL: restUrl, FOUNDRY_REST_API_KEY: key!, FOUNDRY_REST_CLIENT_ID: auth.clientId }),
      },
    });
    transports.push(transport);
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'live-compendium-integration', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    for (const tool of (await client.listTools()).tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    return client;
  }
  beforeAll(async () => {
    const path = process.env.FOUNDRY_REST_TEST_FIXTURES;
    controlUrl = process.env.FOUNDRY_REST_TEST_CONTROL_URL ?? '';
    relay = process.env.FOUNDRY_REST_URL ?? '';
    if (!path || !controlUrl || !relay || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME) {
      throw new Error('Live REST tests require explicit relay, secret fixture file, browser controller, and Foundry credentials');
    }
    auth = fixturesSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const status = await control('/status', 'GET');
    if (status.world !== 'test1world') throw new Error('Disposable test1world is required');
    console.info('Live optional integration versions', JSON.stringify({
      foundry: status.version, module: status.moduleVersion, relay: process.env.FOUNDRY_REST_TEST_VERSION,
    }));
    await keyEnabled(true);
    await control('/enable');
    await control('/seed');
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-compendium-'));
    good = await connect(relay, auth.apiKey);
    socket = await connect();
    wrongKey = await connect(relay, 'invalid-local-test-key');
    searchOnly = await connect(relay, auth.searchOnlyKey);
    plainFoundry = await connect(process.env.FOUNDRY_URL, 'invalid-local-test-key');
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(c => c.close()), ...transports.map(t => t.close())]);
    try {
      if (auth && controlUrl) {
        await keyEnabled(true);
        await control('/enable');
        await control('/seed');
      }
    } finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
  });
  async function call(name: string, args: Record<string, unknown>, client = good) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const schema = schemas.get(name);
    expect(schema).toBeDefined();
    expect(ajv.validate(schema!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const serialized = JSON.stringify(result);
    for (const secret of [auth.apiKey, auth.searchOnlyKey, auth.sessionToken, 'invalid-local-test-key']) {
      expect(serialized.includes(secret), 'MCP results must redact test credentials').toBe(false);
    }
    return { result, text };
  }
  async function search(args: Record<string, unknown>, client = good) {
    const { result, text } = await call('search_compendium', args, client);
    const page = compendiumSearchSchema.parse(result.structuredContent);
    expect(text).toContain(page.capability.status);
    if (!page.restAvailable) expect(text).not.toContain('No compendium entries found');
    return { page, text };
  }
  it('verifies authenticated search and entity reads while leaving unsupported features unavailable', async () => {
    const { result, text } = await call('get_capabilities', {});
    const report = capabilitiesReportSchema.parse(result.structuredContent);
    expect(report.capabilities.map(cap => cap.status)).toEqual(['available', 'unavailable', 'unavailable', 'unavailable']);
    for (const cap of report.capabilities) expect(text).toContain(`${cap.feature}: ${cap.status}`);
  });
  it.each([
    ['Socket.IO without optional REST', () => socket, 'unavailable'],
    ['plain Foundry with an arbitrary key', () => plainFoundry, 'unavailable'],
    ['paired relay with the wrong key', () => wrongKey, 'unauthorized'],
    ['search scope without entity:read', () => searchOnly, 'unauthorized'],
  ] as const)('reports %s accurately', async (_label, client, status) => {
    expect((await search({ query: '', filters: { compendiumId: pack } }, client())).page).toMatchObject({
      restAvailable: false, results: null, total: null, capability: { status },
    });
    const { result } = await call('get_capabilities', {}, client());
    expect(capabilitiesReportSchema.parse(result.structuredContent).capabilities[0]?.status).toBe(status);
  });
  it('returns genuine zero matches only after verifying an authenticated unfiltered entity read', async () => {
    const { page, text } = await search({ query: 'MCP absent compendium fixture 72f53a' });
    expect(page).toMatchObject({ restAvailable: true, results: [], total: 0, complete: true });
    expect(text).toContain('No compendium entries found');
  });
  it('preserves pack/type/level/source filters and text/structured identity parity', async () => {
    const { page, text } = await search({ query: 'MCP Capability', filters: {
      compendiumId: pack, packType: 'Item', itemType: 'spell', spellLevel: 1, source: 'MCP Fixture',
    } });
    expect(page).toMatchObject({ restAvailable: true, total: 1 });
    if (!page.restAvailable) throw new Error('Expected available fixture search');
    const entry = page.results[0]!;
    expect(entry).toMatchObject({ compendiumId: pack, name: 'MCP Capability Alpha', type: 'spell', system: { level: 1 } });
    expect(text).toContain(entry.itemId); expect(text).toContain(pack); expect(text).toContain(entry.name);
  });
  it.each([1, 100, 101, 251])('traverses %i actual compendium entries without omissions or duplicates', async count => {
    await control(`/seed-paging?count=${count}`);
    const args = { query: 'MCP Capability Paging', filters: { compendiumId: pack }, limit: 100 };
    let { page } = await search(args);
    if (!page.restAvailable) throw new Error('Expected available pagination fixture');
    const first = page;
    const names = page.results.map(row => row.name);
    const ids = page.results.map(row => row.itemId);
    while (page.nextCursor) {
      ({ page } = await search({ ...args, cursor: page.nextCursor }));
      if (!page.restAvailable) throw new Error('Expected available continuation');
      expect(page.snapshotId).toBe(first.snapshotId);
      names.push(...page.results.map(row => row.name)); ids.push(...page.results.map(row => row.itemId));
    }
    expect(names).toEqual(Array.from({ length: count }, (_, i) => `MCP Capability Paging ${String(i).padStart(3, '0')}`));
    expect(new Set(ids).size).toBe(count); expect(page.complete).toBe(true);
    if (first.nextCursor) await expect(good.callTool({ name: 'search_compendium', arguments: {
      ...args, query: 'changed', cursor: first.nextCursor,
    } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  }, 90_000);
  it('detects revoked authorization after success and invalidates prior cursors across recovery', async () => {
    const args = { query: 'MCP Capability Paging', filters: { compendiumId: pack }, limit: 100 };
    const { page: first } = await search(args);
    expect(first.nextCursor).toBeTruthy();
    try {
      await keyEnabled(false);
      expect((await search({ ...args, cursor: first.nextCursor })).page).toMatchObject({
        restAvailable: false, results: null, capability: { status: 'unauthorized' },
      });
      const { result } = await call('get_capabilities', {});
      expect(capabilitiesReportSchema.parse(result.structuredContent).capabilities[0]?.status).toBe('unauthorized');
    } finally { await keyEnabled(true); }
    await expect(good.callTool({ name: 'search_compendium', arguments: { ...args, cursor: first.nextCursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect((await search(args)).page.restAvailable).toBe(true);
  });
  it('detects module removal after success and rejects old cursors after re-enabling', async () => {
    const args = { query: 'MCP Capability Paging', filters: { compendiumId: pack }, limit: 100 };
    const { page: first } = await search(args);
    expect(first.nextCursor).toBeTruthy();
    try {
      await control('/disable');
      const { page } = await search({ ...args, cursor: first.nextCursor });
      expect(page.restAvailable).toBe(false);
      expect(page.capability.status).toBe('unavailable');
      const { result } = await call('get_capabilities', {});
      expect(capabilitiesReportSchema.parse(result.structuredContent).capabilities[0]?.status).toBe('unavailable');
    } finally { await control('/enable'); }
    await expect(good.callTool({ name: 'search_compendium', arguments: { ...args, cursor: first.nextCursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect((await search(args)).page.restAvailable).toBe(true);
  }, 90_000);
});

/** Truthful diagnosis availability through built MCP processes and real relay recovery. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('live truthful diagnosis through built MCP stdio', () => {
  let cwd: string;
  let socket: Client;
  let relay: Client;
  let fixture: { apiKey: string; clientId: string };
  let status: { world: string; version: string; system: string; systemVersion: string };
  let controlUrl: string;
  let restoreRelay = false;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  async function control(path: string) {
    const response = await fetch(controlUrl + path, { method: 'POST', signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Test-world control ${path} failed (${response.status})`);
    return response.json();
  }
  async function connect(optionalRest: boolean) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd, stderr: 'pipe', env: {
        NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: process.env.FOUNDRY_URL!,
        FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME!, FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
        FOUNDRY_TIMEOUT: '5000', FOUNDRY_RETRY_ATTEMPTS: '0',
        ...(optionalRest && { FOUNDRY_REST_URL: process.env.FOUNDRY_REST_URL!,
          FOUNDRY_REST_API_KEY: fixture.apiKey, FOUNDRY_REST_CLIENT_ID: fixture.clientId }),
      },
    });
    transports.push(transport);
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'live-diagnosis-integration', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const diagnosis = tools.find(tool => tool.name === 'diagnose_errors');
    expect(diagnosis).toBeDefined();
    expect(diagnosis!.inputSchema.additionalProperties).toBe(false);
    expect(diagnosis!.outputSchema).toBeDefined();
    for (const tool of tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    return client;
  }
  beforeAll(async () => {
    const path = process.env.FOUNDRY_REST_TEST_FIXTURES;
    const sceneControl = process.env.FOUNDRY_SCENE_TEST_CONTROL_URL;
    controlUrl = process.env.FOUNDRY_REST_TEST_CONTROL_URL ?? '';
    if (!path || !sceneControl || !controlUrl || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME || !process.env.FOUNDRY_REST_URL) {
      throw new Error('Live diagnosis tests require explicit test-world controllers, relay fixture and core credentials');
    }
    const response = await fetch(`${sceneControl}/status`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Test-world status failed (${response.status})`);
    status = await response.json();
    expect(status.world).toBe('test1world');
    expect(status.system).toBe('dnd5e');
    expect(status.version).toMatch(/^14\./);
    expect(status.systemVersion).toBeTruthy();
    console.info('Live diagnosis versions', JSON.stringify(status));
    fixture = JSON.parse(await readFile(path, 'utf8'));
    if (typeof fixture.apiKey !== 'string' || !fixture.apiKey || typeof fixture.clientId !== 'string' || !fixture.clientId) {
      throw new Error('Invalid private relay fixture');
    }
    await control('/enable');
    await control('/seed');
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-diagnosis-'));
    socket = await connect(false);
    relay = await connect(true);
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(client => client.close()), ...transports.map(transport => transport.close())]);
    try { if (restoreRelay) await control('/enable'); }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
  });
  async function call(name: string, args: Record<string, unknown>, client = socket) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    expect(result.isError).not.toBe(true);
    if (name !== 'get_world_summary') {
      const schema = schemas.get(name);
      expect(schema).toBeDefined();
      expect(ajv.validate(schema!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    }
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    expect(JSON.stringify(result).includes(fixture.apiKey), 'MCP results must redact relay credentials').toBe(false);
    return { result, text };
  }
  async function diagnosis(args: Record<string, unknown>, client = socket) {
    const { result, text } = await call('diagnose_errors', args, client);
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
  async function availability(client: Client) {
    const { result } = await call('get_capabilities', {}, client);
    return result.structuredContent!.capabilities as Array<Record<string, unknown>>;
  }
  it('verifies the world, system version and core generation through browser and native socket data', async () => {
    const { text } = await call('get_world_summary', {});
    expect(text).toContain(`**World: ${status.world}**`);
    expect(text).toContain(status.system);
    expect(text).toContain(status.systemVersion);
    expect(text).toContain(`**Core Version:** ${status.version.split('.')[0]}`);
  });
  it.each([
    {}, { category: 'all' }, { category: 'connectivity' }, { category: 'authentication' },
    { category: 'unknown-category' }, { category: '模块 😀' },
    { category: '<script>SECRET_DIAGNOSIS_CATEGORY</script>' }, { category: 'x'.repeat(128) },
  ])('returns unavailable without fabricated health or input echo: %j', async args => {
    await diagnosis(args);
  });
  it.each([false, true])('agrees with capability discovery with REST configured=%s', async useRest => {
    const client = useRest ? relay : socket;
    const capability = await diagnosis({}, client);
    const capabilities = await availability(client);
    expect(capabilities.find(cap => cap.feature === 'diagnostics')).toMatchObject(capability);
    if (useRest) expect(capabilities.find(cap => cap.feature === 'compendiumSearch')?.status).toBe('available');
  });
  it.each([
    { category: '' }, { category: '\n\t' }, { category: false }, { category: 1 },
    { category: null }, { category: [] }, { category: {} }, { category: 'x'.repeat(129) },
    { category: 'all', extra: true }, { timeframe: 3600 }, { since: '2026-10-09T00:00:00Z' }, { limit: 1 },
  ])('rejects malformed, excessive or unsupported input with InvalidParams: %j', async args => {
    await expect(socket.callTool({ name: 'diagnose_errors', arguments: args }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
  it('verifies that the paired real relay has no diagnosis endpoint', async () => {
    const url = new URL('/api/diagnostics/errors', process.env.FOUNDRY_REST_URL!);
    url.searchParams.set('clientId', fixture.clientId);
    const response = await fetch(url, { headers: { 'x-api-key': fixture.apiKey }, signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
  it('keeps diagnosis unavailable during real relay failure and after recovery', async () => {
    const baseline = await diagnosis({ category: 'connectivity' }, relay);
    expect((await availability(relay)).find(cap => cap.feature === 'compendiumSearch')?.status).toBe('available');
    restoreRelay = true;
    try {
      await control('/disable');
      expect((await availability(relay)).find(cap => cap.feature === 'compendiumSearch')?.status).toBe('unavailable');
      expect(await diagnosis({ category: 'connectivity' }, relay)).toEqual(baseline);
    } finally {
      await control('/enable');
      restoreRelay = false;
    }
    expect((await availability(relay)).find(cap => cap.feature === 'compendiumSearch')?.status).toBe('available');
    expect(await diagnosis({ category: 'connectivity' }, relay)).toEqual(baseline);
  }, 180_000);
});

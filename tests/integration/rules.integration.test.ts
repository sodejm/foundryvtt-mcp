/** Truthful unsupported lookup through built MCP processes connected to real Foundry. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('live truthful rule lookup through built MCP stdio', () => {
  let cwd: string;
  let socket: Client;
  let relay: Client;
  let fixture: { apiKey: string; clientId: string };
  let status: { world: string; version: string; system: string; systemVersion: string };
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

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
    const client = new Client({ name: 'live-rule-integration', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const lookup = tools.find(tool => tool.name === 'lookup_rule');
    expect(lookup).toBeDefined();
    expect(lookup!.inputSchema.additionalProperties).toBe(false);
    expect(lookup!.outputSchema).toBeDefined();
    for (const tool of tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    return client;
  }
  beforeAll(async () => {
    const path = process.env.FOUNDRY_REST_TEST_FIXTURES;
    const control = process.env.FOUNDRY_SCENE_TEST_CONTROL_URL;
    if (!path || !control || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME || !process.env.FOUNDRY_REST_URL) {
      throw new Error('Live rules tests require explicit test-world controller, relay fixture and core credentials');
    }
    const response = await fetch(`${control}/status`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Test-world status failed (${response.status})`);
    status = await response.json();
    expect(status.world).toBe('test1world');
    expect(status.system).toBe('dnd5e');
    expect(status.version).toMatch(/^14\./);
    expect(status.systemVersion).toBeTruthy();
    console.info('Live rule lookup versions', JSON.stringify(status));
    fixture = JSON.parse(await readFile(path, 'utf8'));
    if (typeof fixture.apiKey !== 'string' || !fixture.apiKey || typeof fixture.clientId !== 'string' || !fixture.clientId) {
      throw new Error('Invalid private relay fixture');
    }
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-rules-'));
    socket = await connect(false);
    relay = await connect(true);
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(client => client.close()), ...transports.map(transport => transport.close())]);
    if (cwd) await rm(cwd, { recursive: true, force: true });
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
    expect(JSON.stringify(result)).not.toContain(fixture.apiKey);
    return { result, text };
  }
  async function rule(args: Record<string, unknown>, client = socket) {
    const { result, text } = await call('lookup_rule', args, client);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(Object.keys(result.structuredContent!).sort()).toEqual(['capability', 'schemaVersion']);
    expect(result.structuredContent).toMatchObject({ schemaVersion: 1, capability: {
      feature: 'rulesLookup', status: 'unavailable', reason: expect.any(String), remediation: expect.any(String),
    } });
    const capability = result.structuredContent!.capability as Record<string, unknown>;
    expect(Object.keys(capability).sort()).toEqual(['feature', 'reason', 'remediation', 'status']);
    expect(String(capability.reason)).not.toHaveLength(0);
    expect(String(capability.remediation)).not.toHaveLength(0);
    expect(text).not.toContain(args.query);
    expect(text).not.toContain('Core Rulebook');
    return capability;
  }
  it('verifies the world, system version and core generation through browser and native socket data', async () => {
    const { text } = await call('get_world_summary', {});
    expect(text).toContain(`**World: ${status.world}**`);
    expect(text).toContain(status.system);
    expect(text).toContain(status.systemVersion);
    expect(text).toContain(`**Core Version:** ${status.version.split('.')[0]}`);
  });
  it.each([
    { query: 'Opportunity attack' }, { query: 'Fireball', system: 'dnd5e' },
    { query: 'Spell', system: 'dnd5e' }, { query: 'MCP absent rule 72f53a' },
    { query: 'Fireball', system: 'dnd5e@0.0.0' }, { query: 'Fireball', system: 'not-installed-system' },
    { query: '规则 😀', system: '自定义' }, { query: '<script>SECRET_RULE_QUERY</script>' },
    { query: 'x'.repeat(256), system: 's'.repeat(128) },
  ])('returns unavailable instead of a fabricated match, ambiguity or empty result: %j', async args => {
    await rule(args);
  });
  it.each([false, true])('agrees with rule capability discovery with REST configured=%s', async useRest => {
    const client = useRest ? relay : socket;
    const capability = await rule({ query: 'Opportunity attack' }, client);
    const { result } = await call('get_capabilities', {}, client);
    const capabilities = result.structuredContent!.capabilities as Array<Record<string, unknown>>;
    expect(capabilities.find(cap => cap.feature === 'rulesLookup')).toMatchObject(capability);
    if (useRest) expect(capabilities.find(cap => cap.feature === 'compendiumSearch')?.status).toBe('available');
  });
  it.each([
    {}, { query: '' }, { query: '\n\t' }, { query: false }, { query: null }, { query: [] },
    { query: 'x'.repeat(257) }, { query: 'valid', system: '' }, { query: 'valid', system: ' ' },
    { query: 'valid', system: false }, { query: 'valid', system: null },
    { query: 'valid', system: 's'.repeat(129) }, { query: 'valid', extra: true },
  ])('rejects malformed or excessive input with InvalidParams: %j', async args => {
    await expect(socket.callTool({ name: 'lookup_rule', arguments: args }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});

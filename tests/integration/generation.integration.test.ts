/** Strict creative previews through built MCP processes connected to the real test world. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertGeneration, invalidLootCases, invalidNpcCases, lootCases, npcCases } from '../helpers/generation-contract.js';

describe('live creative generation through built MCP stdio', () => {
  let cwd: string;
  let fixture: { apiKey: string; clientId: string };
  let status: { world: string; version: string; system: string; systemVersion: string };
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });
  beforeAll(async () => {
    const path = process.env.FOUNDRY_REST_TEST_FIXTURES;
    const sceneControl = process.env.FOUNDRY_SCENE_TEST_CONTROL_URL;
    const restControl = process.env.FOUNDRY_REST_TEST_CONTROL_URL;
    if (!path || !sceneControl || !restControl || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME || !process.env.FOUNDRY_REST_URL) {
      throw new Error('Live generation tests require explicit test-world controllers, relay fixture and core credentials');
    }
    const response = await fetch(`${sceneControl}/status`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Test-world status failed (${response.status})`);
    status = await response.json();
    expect(status.world).toBe('test1world'); expect(status.system).toBe('dnd5e');
    expect(status.version).toMatch(/^14\./); expect(status.systemVersion).toBeTruthy();
    console.info('Live generation versions', JSON.stringify(status));
    fixture = JSON.parse(await readFile(path, 'utf8'));
    if (typeof fixture.apiKey !== 'string' || !fixture.apiKey || typeof fixture.clientId !== 'string' || !fixture.clientId) {
      throw new Error('Invalid private relay fixture');
    }
    for (const action of ['/enable', '/seed']) {
      const control = await fetch(restControl + action, { method: 'POST', signal: AbortSignal.timeout(90_000) });
      if (!control.ok) throw new Error(`Test-world control ${action} failed (${control.status})`);
      await control.body?.cancel();
    }
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-generation-'));
    for (const optionalRest of [false, true]) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], cwd, stderr: 'pipe', env: {
          NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: process.env.FOUNDRY_URL!,
          FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME!, FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
          FOUNDRY_TIMEOUT: '5000', FOUNDRY_RETRY_ATTEMPTS: '0',
          ...(optionalRest && { FOUNDRY_REST_URL: process.env.FOUNDRY_REST_URL!,
            FOUNDRY_REST_API_KEY: fixture.apiKey, FOUNDRY_REST_CLIENT_ID: fixture.clientId }),
        } });
      transports.push(transport); transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'live-generation-integration', version: '1.0.0' });
      clients.push(client); await client.connect(transport);
      for (const name of ['generate_npc', 'generate_loot']) {
        const tool = (await client.listTools()).tools.find(value => value.name === name);
        expect(tool).toBeDefined(); expect(tool!.inputSchema.additionalProperties).toBe(false);
        expect(tool!.outputSchema).toBeDefined(); schemas.set(name, tool!.outputSchema!);
      }
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(client => client.close()), ...transports.map(transport => transport.close())]);
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });
  async function generate(name: string, args: Record<string, unknown>, client = clients[0]!) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    expect(ajv.validate(schemas.get(name)!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    expect(JSON.stringify(result).includes(fixture.apiKey), 'Results must redact relay credentials').toBe(false);
    return assertGeneration(result, name, args);
  }
  it.each(npcCases)('honors NPC options as non-persisted narrative previews: %j', async args => {
    await generate('generate_npc', args);
  });
  it.each(lootCases)('honors loot options with traceable fictional currency: %j', async args => {
    await generate('generate_loot', args);
  });
  for (const [name, cases] of [['generate_npc', invalidNpcCases], ['generate_loot', invalidLootCases]] as const) {
    it.each(cases)(`rejects unsupported or invalid ${name} input: %j`, async args => {
      await expect(clients[0]!.callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    });
  }
  it.each([0, 1])('distinguishes local previews from unavailable verified generation, transport %s', async index => {
    const client = clients[index]!;
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    const capabilities = result.structuredContent!.capabilities as Array<Record<string, unknown>>;
    expect(capabilities.find(capability => capability.feature === 'contentGeneration')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('creative previews are available'),
    });
    if (index === 1) expect(capabilities.find(capability => capability.feature === 'compendiumSearch')?.status).toBe('available');
    await generate('generate_npc', { level: 20, race: 'Clockwork', class: 'Archivist' }, client);
    await generate('generate_loot', { challengeRating: 30, treasureType: 'hoard' }, client);
  });
  it('preserves real world collection counts across both generation tools and transports', async () => {
    const client = clients[0]!;
    const summary = async () => {
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_world_summary', arguments: {} }));
      expect(result.isError).not.toBe(true);
      return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    };
    const before = await summary();
    expect(before).toContain(`**World: ${status.world}**`);
    expect(before).toContain(status.systemVersion);
    expect(before).toContain(`**Core Version:** ${status.version.split('.')[0]}`);
    const collectionCounts = (text: string) => Object.fromEntries(
      [...text.matchAll(/^- \*\*([^*]+)\*\*: (\d+)$/gm)].map(([, name, count]) => [name, Number(count)]),
    );
    const beforeCounts = collectionCounts(before);
    expect(Object.keys(beforeCounts).length).toBeGreaterThan(0);
    for (const transport of clients) {
      await generate('generate_npc', { level: 20 }, transport);
      await generate('generate_loot', { challengeRating: 30, treasureType: 'hoard' }, transport);
    }
    const refresh = CallToolResultSchema.parse(await client.callTool({ name: 'refresh_world_data', arguments: {} }));
    expect(refresh.isError).not.toBe(true);
    const after = await summary();
    expect(after).toContain(`**World: ${status.world}**`);
    expect(after).toContain(status.systemVersion);
    expect(after).toContain(`**Core Version:** ${status.version.split('.')[0]}`);
    expect(collectionCounts(after)).toEqual(beforeCounts);
  });
});

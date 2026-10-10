/** Built MCP generation contracts, strict input errors and zero Foundry requests. */
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
import { assertGeneration, invalidLootCases, invalidNpcCases, lootCases, npcCases } from '../helpers/generation-contract.js';

describe('built MCP creative generation workflow', () => {
  let server: Server;
  let cwd: string;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });
  let requests: string[] = [];

  beforeEach(() => { requests = []; });
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push(`${request.method} ${url.pathname}`);
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/status') response.end('{"connected":true}');
      else response.writeHead(503).end('{"error":"No generation source exists"}');
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    cwd = await mkdtemp(join(tmpdir(), 'foundry-generation-workflow-'));
    for (const rest of [false, true]) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], cwd, stderr: 'pipe', env: {
          NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: `http://127.0.0.1:${address.port}`,
          FOUNDRY_API_KEY: 'workflow-core-key', FOUNDRY_TIMEOUT: '200', FOUNDRY_RETRY_ATTEMPTS: '0',
          ...(rest && { FOUNDRY_REST_URL: `http://127.0.0.1:${address.port}`, FOUNDRY_REST_API_KEY: 'workflow-rest-key', FOUNDRY_REST_CLIENT_ID: 'fixture' }),
        } });
      transports.push(transport); transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'generation-workflow', version: '1.0.0' });
      clients.push(client); await client.connect(transport);
      const tools = (await client.listTools()).tools;
      for (const name of ['generate_npc', 'generate_loot']) {
        const tool = tools.find(value => value.name === name);
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.additionalProperties).toBe(false);
        expect(tool!.outputSchema).toBeDefined();
        expect(tool!.description).toMatch(/creative preview/i);
        schemas.set(name, tool!.outputSchema!);
      }
      expect(tools.some(tool => tool.name === 'create_actor_item')).toBe(true);
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(client => client.close()), ...transports.map(transport => transport.close())]);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });
  async function generate(name: string, args: Record<string, unknown>, client = clients[0]!) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    expect(ajv.validate(schemas.get(name)!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    assertGeneration(result, name, args);
    expect(requests).toEqual([]);
  }
  it.each(npcCases)('honors NPC narrative inputs without source access: %j', async args => {
    await generate('generate_npc', args);
  });
  it.each(lootCases)('honors loot inputs with traceable currency and unknown total: %j', async args => {
    await generate('generate_loot', args);
  });
  for (const [name, cases] of [['generate_npc', invalidNpcCases], ['generate_loot', invalidLootCases]] as const) {
    it.each(cases)(`rejects invalid ${name} input before any request: %j`, async args => {
      await expect(clients[0]!.callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(requests).toEqual([]);
    });
  }
  it.each([0, 1])('keeps creative generation available with no usable REST provider, transport %s', async index => {
    const client = clients[index]!;
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    const capabilities = result.structuredContent!.capabilities as Array<Record<string, unknown>>;
    expect(capabilities.find(capability => capability.feature === 'contentGeneration')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('creative previews are available'),
    });
    requests = [];
    await generate('generate_npc', { race: 'Unspecified world', class: 'Storyteller' }, client);
    await generate('generate_loot', { challengeRating: 30, treasureType: 'hoard' }, client);
  });
});

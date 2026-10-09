/** Built MCP dice contracts and request-count proof for uncertain remote failures. */
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
import { assertDice, invalidDiceCases, validDiceCases } from '../helpers/dice-contract.js';

describe('built MCP bounded dice workflow', () => {
  let server: Server;
  let cwd: string;
  let mode = 'success';
  let attempts: Array<{ path: string; body: Record<string, unknown>; key: string | undefined }> = [];
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas: object[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  beforeEach(() => { attempts = []; mode = 'success'; });
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (url.pathname !== '/roll') { response.writeHead(404).end('{}'); return; }
      attempts.push({ path: request.url!, body: JSON.parse(raw), key: request.headers['x-api-key'] as string | undefined });
      response.setHeader('content-type', 'application/json');
      if (['401', '403', '500'].includes(mode)) { response.writeHead(Number(mode)).end('{"error":"fixture-key"}'); return; }
      if (mode === 'timeout') { setTimeout(() => response.end('{}'), 600); return; }
      if (mode === 'disconnect') { request.socket.destroy(); return; }
      const roll = { formula: '2d6kh1 + 3', total: 9, timestamp: Date.now(),
        dice: [{ faces: 6, results: [{ result: 6, active: true }, { result: 1, active: false }] }] };
      if (mode === 'wrong-total') roll.total = 10;
      if (mode === 'wrong-formula') roll.formula = '2d6kh1 + 4';
      if (mode === 'wrong-face') roll.dice[0]!.results[0]!.result = 7;
      if (mode === 'wrong-active') roll.dice[0]!.results[1]!.active = true;
      if (mode === 'missing-die') roll.dice = [];
      const envelope = { type: 'roll-result', requestId: 'fixture', success: mode !== 'unsuccessful',
        data: { id: 'manual_fixture', chatMessageCreated: mode === 'chat-created', roll } };
      response.end(mode === 'malformed' ? '{' : JSON.stringify(envelope));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const url = `http://127.0.0.1:${address.port}`;
    cwd = await mkdtemp(join(tmpdir(), 'foundry-dice-workflow-'));
    for (const config of [{}, { FOUNDRY_REST_URL: url, FOUNDRY_REST_API_KEY: 'fixture-key', FOUNDRY_REST_CLIENT_ID: 'fixture' }, { FOUNDRY_REST_URL: url }]) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], cwd, stderr: 'pipe', env: {
          NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: url, FOUNDRY_USERNAME: 'fixture',
          FOUNDRY_TIMEOUT: '200', FOUNDRY_RETRY_ATTEMPTS: '3', ...config,
        } });
      transports.push(transport); transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'dice-workflow', version: '1.0.0' });
      clients.push(client); await client.connect(transport);
      const tool = (await client.listTools()).tools.find(value => value.name === 'roll_dice');
      expect(tool).toBeDefined(); expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect(tool!.outputSchema).toBeDefined(); schemas.push(tool!.outputSchema!);
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(client => client.close()), ...transports.map(transport => transport.close())]);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });
  async function call(index: number, args: Record<string, unknown>) {
    return CallToolResultSchema.parse(await clients[index]!.callTool({ name: 'roll_dice', arguments: args }));
  }
  it.each(validDiceCases)('supports bounded grammar without a configured transport: %s', async formula => {
    const result = await call(0, { formula, reason: 'workflow provenance' });
    const value = assertDice(result, 'local');
    expect(value.reason).toBe('workflow provenance');
    expect(value.fallback).toEqual({ requestedEngine: 'auto', reason: 'foundry-transport-not-configured' });
    expect(ajv.validate(schemas[0]!, value), JSON.stringify(ajv.errors)).toBe(true);
    expect(attempts).toEqual([]);
  });
  for (const index of [0, 1, 2]) {
    it.each(invalidDiceCases)(`rejects invalid input before rolling, transport ${index}: %j`, async args => {
      await expect(call(index, args)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(attempts).toEqual([]);
    });
    it(`uses an explicitly selected local engine without transport ${index}`, async () => {
      const value = assertDice(await call(index, { formula: '(7 - 3) + 2', engine: 'local' }), 'local');
      expect(value.total).toBe(6); expect(value.fallback).toBeNull(); expect(attempts).toEqual([]);
    });
  }
  it('fails a required Foundry engine or partial configuration before rolling', async () => {
    for (const [index, args] of [[0, { formula: '1d6', engine: 'foundry' }], [2, { formula: '1d6' }]] as const) {
      const result = await call(index, args); expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined(); expect(attempts).toEqual([]);
    }
  });
  it.each(['auto', 'foundry'])('returns verified server outcomes once for engine %s', async engine => {
    const result = await call(1, { formula: '2d6kh1 + 3', engine });
    const value = assertDice(result, 'foundry');
    expect(value.total).toBe(9); expect(value.fallback).toBeNull();
    expect(ajv.validate(schemas[1]!, value), JSON.stringify(ajv.errors)).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ key: 'fixture-key', body: { createChatMessage: false } });
    expect(new URL(attempts[0]!.path, 'http://fixture').searchParams.get('clientId')).toBe('fixture');
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });
  it.each(['401', '403', '500', 'timeout', 'disconnect', 'malformed', 'unsuccessful', 'wrong-total',
    'wrong-formula', 'wrong-face', 'wrong-active', 'missing-die', 'chat-created'])('never retries or rolls locally after %s', async failure => {
    mode = failure;
    const result = await call(1, { formula: '2d6kh1 + 3', engine: 'auto' });
    expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined();
    expect(attempts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(attempts).toHaveLength(1);
  });
});

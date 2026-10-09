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
import { WebSocketServer } from 'ws';
import { assertDice, invalidDiceCases, validDiceCases } from '../helpers/dice-contract.js';

describe('built MCP bounded dice workflow', () => {
  let server: Server;
  let sockets: WebSocketServer;
  let cwd: string;
  let mode = 'success';
  let attempts: Array<{ method: string | undefined; path: string; body: Record<string, unknown>; key: string | undefined }> = [];
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas: object[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const pairedClientId = 'fixture client/+';
  const userId = 'fixtureUser00001';
  beforeEach(() => { attempts = []; mode = 'success'; });
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/join') {
        response.setHeader('set-cookie', 'session=fixture-session; HttpOnly; Path=/');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'success' })); return;
      }
      if (url.pathname === '/api/status') { response.end('{"connected":true}'); return; }
      if (url.pathname !== '/roll') { response.writeHead(404).end('{}'); return; }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      attempts.push({ method: request.method, path: request.url!, body: JSON.parse(raw || '{}'), key: request.headers['x-api-key'] as string | undefined });
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
      if (mode === 'extra-die') roll.dice.push({ faces: 6, results: [{ result: 1, active: true }] });
      if (mode === 'extra-outcome') roll.dice[0]!.results.push({ result: 1, active: false });
      if (mode === 'wrong-die-faces') roll.dice[0]!.faces = 8;
      if (mode === 'fractional-outcome') roll.dice[0]!.results[0]!.result = 1.5;
      if (mode === 'missing-active') Reflect.deleteProperty(roll.dice[0]!.results[0]!, 'active');
      if (mode === 'missing-faces') Reflect.deleteProperty(roll.dice[0]!, 'faces');
      if (mode === 'wrong-timestamp') Object.assign(roll, { timestamp: 'now' });
      if (mode === 'unknown-roll-field') Object.assign(roll, { unverified: true });
      if (mode === 'unknown-die-field') Object.assign(roll.dice[0]!, { unverified: true });
      if (mode === 'unknown-result-field') Object.assign(roll.dice[0]!.results[0]!, { unverified: true });
      if (mode === 'optional-roll-fields') Object.assign(roll, { isCritical: false, isFumble: false });
      const envelope = { type: 'roll-result', requestId: 'fixture', success: mode !== 'unsuccessful',
        data: { id: 'manual_fixture', chatMessageCreated: mode === 'chat-created', roll } };
      if (mode === 'wrong-envelope-type') envelope.type = 'other-result';
      if (mode === 'missing-request-id') Reflect.deleteProperty(envelope, 'requestId');
      if (mode === 'unknown-envelope-field') Object.assign(envelope, { unverified: true });
      if (mode === 'unknown-data-field') Object.assign(envelope.data, { unverified: true });
      response.end(mode === 'malformed' ? '{' : JSON.stringify(envelope));
    });
    // Real CLI bootstrap uses the authenticated Socket.IO session and a world snapshot.
    sockets = new WebSocketServer({ server, path: '/socket.io/' });
    sockets.on('connection', socket => {
      socket.send(`0${JSON.stringify({ sid: 'fixture-session', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
      socket.on('message', raw => {
        const packet = raw.toString();
        if (packet === '40') {
          socket.send('40{"sid":"fixture-session"}');
          socket.send(`42${JSON.stringify(['session', { userId }])}`);
        } else if (packet === '2') socket.send('3');
        const worldRequest = /^42(\d+)\["world"\]$/.exec(packet);
        if (worldRequest) socket.send(`43${worldRequest[1]}${JSON.stringify([{
          userId, release: { version: '14.369' }, world: { id: 'fixture' }, system: { id: 'fixture' },
          modules: [], demoMode: false, actors: [], scenes: [], items: [], journal: [], messages: [], combats: [],
          users: [{ _id: userId, name: 'Fixture', role: 4, color: '#ffffff' }], activeUsers: [userId],
          settings: [], macros: [], playlists: [], tables: [], folders: [], cards: [], packs: [],
        }])}`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const url = `http://127.0.0.1:${address.port}`;
    cwd = await mkdtemp(join(tmpdir(), 'foundry-dice-workflow-'));
    for (const config of [{},
      { FOUNDRY_REST_URL: url, FOUNDRY_REST_API_KEY: 'fixture-key', FOUNDRY_REST_CLIENT_ID: pairedClientId },
      { FOUNDRY_REST_URL: url },
      { FOUNDRY_API_KEY: 'legacy-dice-key' },
      { FOUNDRY_REST_URL: url, FOUNDRY_REST_API_KEY: 'fixture-key', FOUNDRY_REST_CLIENT_ID: pairedClientId, FOUNDRY_API_KEY: 'legacy-dice-key' },
      { FOUNDRY_REST_API_KEY: 'fixture-key' },
      { FOUNDRY_REST_CLIENT_ID: pairedClientId },
      { FOUNDRY_REST_URL: url, FOUNDRY_REST_API_KEY: 'fixture-key' },
      { FOUNDRY_REST_URL: url, FOUNDRY_REST_CLIENT_ID: pairedClientId },
      { FOUNDRY_REST_API_KEY: 'fixture-key', FOUNDRY_REST_CLIENT_ID: pairedClientId },
    ]) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], cwd, stderr: 'pipe', env: {
          NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: url, FOUNDRY_USER_ID: userId, FOUNDRY_PASSWORD: '',
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
    if (sockets) {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });
  async function call(index: number, args: Record<string, unknown>) {
    return CallToolResultSchema.parse(await clients[index]!.callTool({ name: 'roll_dice', arguments: args }));
  }
  async function internalFailure(index: number, args: Record<string, unknown>) {
    const error = await call(index, args).then(() => { throw new Error('Expected tool execution to fail'); }, error => error);
    expect(error).toMatchObject({ code: ErrorCode.InternalError });
    expect(String(error)).not.toContain('fixture-key');
    expect(String(error)).not.toContain('legacy-dice-key');
    return error;
  }
  it.each(validDiceCases)('supports bounded grammar without a configured transport: %s', async formula => {
    const result = await call(0, { formula, reason: 'workflow provenance' });
    const value = assertDice(result, 'local');
    expect(value.reason).toBe('workflow provenance');
    expect(value.fallback).toEqual({ requestedEngine: 'auto', reason: 'foundry-transport-not-configured' });
    expect(ajv.validate(schemas[0]!, value), JSON.stringify(ajv.errors)).toBe(true);
    expect(attempts).toEqual([]);
  });
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
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
      await internalFailure(index, args); expect(attempts).toEqual([]);
    }
  });
  for (const index of [2, 5, 6, 7, 8, 9]) {
    it.each(['auto', 'foundry'])(`fails partial paired configuration ${index} for engine %s before HTTP`, async engine => {
      await internalFailure(index, { formula: '1d6', engine });
      expect(attempts).toEqual([]);
    });
  }
  it.each(['auto', 'foundry'])('rejects an unsupported legacy dice transport for engine %s before HTTP', async engine => {
    const error = await internalFailure(3, { formula: '1d6', engine });
    expect(String(error)).toMatch(/legacy|FOUNDRY_REST/i);
    expect(attempts).toEqual([]);
  });
  it('prefers complete paired configuration when a legacy API key is also present', async () => {
    const value = assertDice(await call(4, { formula: '2d6kh1 + 3' }), 'foundry');
    expect(value.total).toBe(9); expect(value.fallback).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ method: 'POST', key: 'fixture-key', body: { createChatMessage: false } });
    expect(new URL(attempts[0]!.path, 'http://fixture').pathname).toBe('/roll');
  });
  it.each(['auto', 'foundry'])('returns verified server outcomes once for engine %s', async engine => {
    const result = await call(1, { formula: '2d6kh1 + 3', engine, reason: 'workflow native roll' });
    const value = assertDice(result, 'foundry');
    expect(value.total).toBe(9); expect(value.fallback).toBeNull();
    expect(ajv.validate(schemas[1]!, value), JSON.stringify(ajv.errors)).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ method: 'POST', key: 'fixture-key', body: { formula: value.normalizedFormula,
      createChatMessage: false, flavor: 'workflow native roll' } });
    expect(new URL(attempts[0]!.path, 'http://fixture').searchParams.get('clientId')).toBe(pairedClientId);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });
  it('accepts documented optional roll metadata without changing verified outcomes', async () => {
    mode = 'optional-roll-fields';
    const value = assertDice(await call(1, { formula: '2d6kh1 + 3' }), 'foundry');
    expect(value.total).toBe(9); expect(attempts).toHaveLength(1);
  });
  for (const engine of ['auto', 'foundry']) {
    it.each(['401', '403', '500', 'timeout', 'disconnect', 'malformed', 'unsuccessful', 'wrong-total',
      'wrong-formula', 'wrong-face', 'wrong-active', 'missing-die', 'chat-created', 'extra-die',
      'extra-outcome', 'wrong-die-faces', 'fractional-outcome', 'missing-active', 'missing-faces',
      'wrong-timestamp', 'unknown-roll-field', 'unknown-die-field', 'unknown-result-field',
      'wrong-envelope-type', 'missing-request-id', 'unknown-envelope-field', 'unknown-data-field',
    ])(`never retries or rolls locally after %s with engine ${engine}`, async failure => {
      mode = failure;
      await internalFailure(1, { formula: '2d6kh1 + 3', engine });
      expect(attempts).toHaveLength(1);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(attempts).toHaveLength(1);
    });
  }
});

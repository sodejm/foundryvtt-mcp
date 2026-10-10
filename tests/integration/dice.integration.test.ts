/** Deterministic official-engine parity and built MCP rolls in the disposable world. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateDiceFormula } from '../../dist/foundry/dice-formula.js';
import { assertDice, invalidDiceCases, validDiceCases } from '../helpers/dice-contract.js';

describe('live bounded dice through built MCP and official controlled RNG', () => {
  let cwd: string;
  let controller: string;
  let fixture: { diceKey: string; clientId: string };
  let uncertainProxy: Server;
  let uncertainFailure: 'disconnect' | 'timeout' = 'disconnect';
  let remoteAttempts = 0;
  let completedRemoteRolls = 0;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas: object[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  beforeAll(async () => {
    controller = process.env.FOUNDRY_DICE_TEST_CONTROL_URL ?? '';
    const fixturePath = process.env.FOUNDRY_REST_TEST_FIXTURES;
    if (!controller || !fixturePath || !process.env.FOUNDRY_REST_URL || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME) {
      throw new Error('Live dice tests require explicit disposable-world credentials, relay fixture and official RNG controller');
    }
    const status = await oracleStatus();
    expect(status).toMatchObject({ world: 'test1world', system: 'dnd5e', randomSource: 'function' });
    expect(status.version).toMatch(/^14\./); expect(status.systemVersion).toBeTruthy();
    expect(status.modules).toContainEqual({ id: 'foundry-rest-api', version: process.env.FOUNDRY_REST_TEST_VERSION });
    console.info('Live dice versions', JSON.stringify(status));
    fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    if (!fixture.diceKey || !fixture.clientId) throw new Error('Private relay fixture requires a dedicated roll:execute key');
    uncertainProxy = createServer(async (request, response) => {
      if (request.method !== 'POST' || !request.url?.startsWith('/roll?')) {
        response.writeHead(404).end('{}'); return;
      }
      remoteAttempts++;
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const remote = await fetch(`${process.env.FOUNDRY_REST_URL}${request.url}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': request.headers['x-api-key'] as string },
          body, signal: AbortSignal.timeout(15_000),
        });
        const value = await remote.json();
        if (remote.ok && value.success === true && value.data?.roll && value.data.chatMessageCreated === false) completedRemoteRolls++;
        // The actual engine response was received; deliberately prevent MCP from observing it.
        if (uncertainFailure === 'disconnect') request.socket.destroy();
        else setTimeout(() => response.end(JSON.stringify(value)), 10_000).unref();
      } catch { response.writeHead(502).end('{}'); }
    });
    await new Promise<void>((resolve, reject) => {
      uncertainProxy.once('error', reject); uncertainProxy.listen(0, '127.0.0.1', resolve);
    });
    const address = uncertainProxy.address();
    if (!address || typeof address === 'string') throw new Error('Missing uncertain-execution proxy port');
    const uncertainUrl = `http://127.0.0.1:${address.port}`;
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-dice-'));
    for (const mode of ['local', 'foundry', 'denied', 'uncertain']) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], cwd, stderr: 'pipe', env: {
          NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: process.env.FOUNDRY_URL!,
          FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME!, FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
          FOUNDRY_TIMEOUT: '5000', FOUNDRY_RETRY_ATTEMPTS: '3',
          ...(mode !== 'local' && { FOUNDRY_REST_URL: mode === 'uncertain' ? uncertainUrl : process.env.FOUNDRY_REST_URL!,
            FOUNDRY_REST_API_KEY: mode === 'denied' ? 'invalid-test-dice-key' : fixture.diceKey,
            FOUNDRY_REST_CLIENT_ID: fixture.clientId }),
        } });
      transports.push(transport); transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'live-dice-integration', version: '1.0.0' });
      clients.push(client); await client.connect(transport);
      const tool = (await client.listTools()).tools.find(value => value.name === 'roll_dice');
      expect(tool).toBeDefined(); expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect(tool!.outputSchema).toBeDefined(); schemas.push(tool!.outputSchema!);
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(client => client.close()), ...transports.map(transport => transport.close())]);
    if (uncertainProxy) {
      uncertainProxy.closeAllConnections();
      await new Promise<void>(resolve => uncertainProxy.close(() => resolve()));
    }
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });
  async function oracleStatus() {
    const response = await fetch(`${controller}/status`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Official RNG status failed (${response.status})`);
    return response.json();
  }
  async function call(index: number, args: Record<string, unknown>) {
    const result = CallToolResultSchema.parse(await clients[index]!.callTool({ name: 'roll_dice', arguments: args }));
    expect(JSON.stringify(result)).not.toContain(fixture.diceKey);
    return result;
  }
  async function internalFailure(index: number, args: Record<string, unknown>) {
    const error = await call(index, args).then(() => { throw new Error('Expected tool execution to fail'); }, error => error);
    expect(error).toMatchObject({ code: ErrorCode.InternalError });
    expect(String(error)).not.toContain(fixture.diceKey);
    expect(String(error)).not.toContain('invalid-test-dice-key');
  }
  it.each(validDiceCases)('matches official outcomes with identical controlled RNG: %s', async formula => {
    const uniforms = Array.from({ length: 1000 }, (_, index) => [0.9, 0, 0.4, 0.2][index % 4]!);
    let consumed = 0;
    const local = evaluateDiceFormula(formula, () => uniforms[consumed++]!);
    const response = await fetch(`${controller}/roll`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formula, uniforms }), signal: AbortSignal.timeout(15_000) });
    expect(response.ok).toBe(true);
    const official = await response.json();
    expect(official.error).toBeUndefined(); expect(official.consumed).toBe(consumed);
    expect(local.total).toBe(official.total);
    expect(local.dice.map(({ faces, results }) => ({ faces, results }))).toEqual(official.dice);
  });
  it.each(['4d6kh2', '4d6kl2', '4d6dh2', '4d6dl2'])('matches native tie selection for %s', async formula => {
    const uniforms = [0.5, 0.5, 0.5, 0.5];
    const local = evaluateDiceFormula(formula, () => 0.5);
    const response = await fetch(`${controller}/roll`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formula, uniforms }), signal: AbortSignal.timeout(15_000) });
    expect(response.ok).toBe(true);
    const official = await response.json();
    expect(official.error).toBeUndefined(); expect(official.consumed).toBe(4);
    expect(local.total).toBe(official.total);
    expect(local.dice.map(({ faces, results }) => ({ faces, results }))).toEqual(official.dice);
  });
  for (const index of [1, 2]) {
    it(`keeps automatic dice local even with native credentials ${index}`, async () => {
      for (const extra of [{}, { engine: 'auto' }]) {
        const value = assertDice(await call(index, { formula: '(7-3)+2', ...extra }), 'local');
        expect(value.total).toBe(6);
        expect(value.fallback).toEqual({ requestedEngine: 'auto', reason: 'foundry-execution-not-requested' });
        expect(ajv.validate(schemas[index]!, value), JSON.stringify(ajv.errors)).toBe(true);
      }
    });
  }
  for (const index of [0, 1]) {
    it.each(validDiceCases)(`returns the advertised contract with live transport ${index}: %s`, async formula => {
      const result = await call(index, { formula, reason: 'live dice proof', ...(index === 1 && { engine: 'foundry' }) });
      const value = assertDice(result, index === 0 ? 'local' : 'foundry');
      expect(ajv.validate(schemas[index]!, value), JSON.stringify(ajv.errors)).toBe(true);
      expect(value.reason).toBe('live dice proof');
      expect(value.fallback).toEqual(index === 0 ? { requestedEngine: 'auto', reason: 'foundry-transport-not-configured' } : null);
      if (formula === '((7 - 3) + 2)') expect(value.total).toBe(6);
      if (formula === '999d1') expect(value.total).toBe(999);
      if (formula === '500d1+500d1') expect(value.total).toBe(1000);
    });
    it.each(invalidDiceCases)(`rejects invalid input before a live roll, transport ${index}: %j`, async args => {
      await expect(call(index, args)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    });
  }
  it('preserves local selection and returns a real authorization failure without a fallback', async () => {
    const local = assertDice(await call(2, { formula: '(7 - 3) + 2', engine: 'local' }), 'local');
    expect(local.total).toBe(6); expect(local.fallback).toBeNull();
    await internalFailure(2, { formula: '1d6', engine: 'foundry' });
    const foundry = assertDice(await call(1, { formula: '(7 - 3) + 2', engine: 'foundry' }), 'foundry');
    expect(foundry.total).toBe(6); expect(foundry.fallback).toBeNull();
  });
  it('evaluates native rolls without creating chat messages', async () => {
    const before = await oracleStatus();
    for (const formula of ['1d20+5', '4d6kh3', '(2d6+3)-(1d4-2)']) assertDice(await call(1, { formula, engine: 'foundry' }), 'foundry');
    const after = await oracleStatus();
    expect(after.chatMessageCount).toBe(before.chatMessageCount);
  });
  it.each(['disconnect', 'timeout'] as const)('returns an error after actual evaluation with a lost response (%s) without rolling again', async failure => {
    uncertainFailure = failure;
    const attemptsBefore = remoteAttempts;
    const completedBefore = completedRemoteRolls;
    const before = await oracleStatus();
    await internalFailure(3, { formula: '4d6kh3 + 2', engine: 'foundry' });
    expect(remoteAttempts - attemptsBefore).toBe(1); expect(completedRemoteRolls - completedBefore).toBe(1);
    const after = await oracleStatus();
    expect(after.chatMessageCount).toBe(before.chatMessageCount);
    expect(remoteAttempts - attemptsBefore).toBe(1);
  });
});

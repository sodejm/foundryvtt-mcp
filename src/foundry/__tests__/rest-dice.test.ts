import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDiceFormula } from '../dice-formula.js';
import { DiceRestAdapter, type DiceRestOptions } from '../rest-dice.js';

vi.mock('axios');

const post = vi.fn();
const options: DiceRestOptions = {
  baseUrl: 'http://localhost:3010',
  apiKey: 'fixture-key',
  clientId: 'fixture client/+',
};
const parsed = parseDiceFormula('2d6kh1+3');

function envelope() {
  return {
    type: 'roll-result',
    requestId: 'fixture-request',
    success: true,
    data: {
      id: 'manual_fixture',
      chatMessageCreated: false,
      roll: {
        formula: parsed.normalizedFormula,
        total: 9,
        timestamp: 1_791_504_000_000,
        dice: [
          {
            faces: 6,
            results: [
              { result: 6, active: true },
              { result: 1, active: false },
            ],
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(axios.create).mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);
  post.mockResolvedValue({ data: envelope() });
});

describe('bounded native dice transport', () => {
  it('configures an authenticated request with bounded size, timeout, and no redirects', () => {
    new DiceRestAdapter(options);
    expect(axios.create).toHaveBeenCalledExactlyOnceWith({
      baseURL: 'http://localhost:3010/',
      headers: { 'x-api-key': 'fixture-key' },
      timeout: 10_000,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024,
      responseType: 'json',
    });
  });

  it('accepts HTTPS, a path prefix, and a positive custom timeout', () => {
    new DiceRestAdapter({ ...options, baseUrl: 'https://localhost:3010/relay/', timeout: 250 });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://localhost:3010/relay/',
        timeout: 250,
      }),
    );
  });

  it.each([
    { baseUrl: 'not-a-url' },
    { baseUrl: 'file:///fixture' },
    { baseUrl: 'http://user@localhost:3010' },
    { baseUrl: 'http://:secret@localhost:3010' },
    { baseUrl: 'http://localhost:3010?key=secret' },
    { baseUrl: 'http://localhost:3010#secret' },
    { apiKey: ' ' },
    { clientId: ' ' },
    { timeout: Number.NaN },
    { timeout: 0 },
    { timeout: -1 },
    { timeout: 0.5 },
    { timeout: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid configuration without exposing it: %j', (invalid) => {
    expect(() => new DiceRestAdapter({ ...options, ...invalid })).toThrow(
      'Invalid Foundry dice REST configuration.',
    );
    expect(axios.create).not.toHaveBeenCalled();
  });

  it('redacts transport initialization errors', () => {
    vi.mocked(axios.create).mockImplementation(() => {
      throw new Error('fixture-key');
    });
    expect(() => new DiceRestAdapter(options)).toThrow('Invalid Foundry dice REST configuration.');
  });

  it('makes one native roll and verifies the outcomes, total, and timestamp', async () => {
    const result = await new DiceRestAdapter(options).roll(parsed);
    expect(result).toMatchObject({
      normalizedFormula: parsed.normalizedFormula,
      total: 9,
      timestamp: new Date(1_791_504_000_000).toISOString(),
      dice: [
        {
          faces: 6,
          results: [
            { result: 6, active: true },
            { result: 1, active: false },
          ],
        },
      ],
    });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/roll',
      {
        formula: parsed.normalizedFormula,
        createChatMessage: false,
      },
      { params: { clientId: 'fixture client/+' } },
    );
  });

  it('passes the optional delegated user and flavor and accepts native flags', async () => {
    const data = envelope();
    Object.assign(data.data.roll, { isCritical: false, isFumble: false });
    post.mockResolvedValue({ data });
    await new DiceRestAdapter({ ...options, userId: 'fixture-user' }).roll(parsed, 'attack');
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/roll',
      {
        formula: parsed.normalizedFormula,
        createChatMessage: false,
        flavor: 'attack',
      },
      { params: { clientId: 'fixture client/+', userId: 'fixture-user' } },
    );
  });

  it.each([
    'formula',
    'total',
    'active',
    'unknown-field',
    'chat-created',
  ])('rejects inconsistent %s without a reroll', async (mismatch) => {
    const data = envelope();
    if (mismatch === 'formula') {
      data.data.roll.formula = '1d6';
    }
    if (mismatch === 'total') {
      data.data.roll.total = 99;
    }
    if (mismatch === 'active') {
      data.data.roll.dice = [
        {
          faces: 6,
          results: [
            { result: 6, active: true },
            { result: 1, active: true },
          ],
        },
      ];
    }
    if (mismatch === 'unknown-field') {
      Object.assign(data, { unexpected: true });
    }
    if (mismatch === 'chat-created') {
      data.data.chatMessageCreated = true;
    }
    post.mockResolvedValue({ data });
    const random = vi.spyOn(Math, 'random');
    try {
      await expect(new DiceRestAdapter(options).roll(parsed)).rejects.toThrow(
        'no retry or local fallback was attempted',
      );
      expect(post).toHaveBeenCalledOnce();
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it('redacts uncertain transport errors and never retries', async () => {
    post.mockRejectedValue(new Error('fixture-key ambiguous outcome'));
    await expect(new DiceRestAdapter(options).roll(parsed)).rejects.toThrow(
      'Foundry dice roll failed; no retry or local fallback was attempted.',
    );
    expect(post).toHaveBeenCalledOnce();
  });
});

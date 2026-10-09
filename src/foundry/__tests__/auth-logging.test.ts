import axios from 'axios';
import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../utils/logger.js';
import { authenticateFoundry } from '../auth.js';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../../config/index.js', () => ({ config: { logLevel: 'debug' } }));

describe('authentication logging with the production logger', () => {
  const username = 'private-gamemaster-name';
  const userId = 'privateUserId123';
  const password = 'private-test-password';
  const session = 'private-test-session';
  let output: string[];

  beforeEach(() => {
    output = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((message: unknown) => {
        output.push(String(message));
      });
    }
    vi.mocked(axios.get).mockResolvedValue({
      headers: { 'set-cookie': [`session=${session}; Path=/`] },
    });
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { status: 'success' } });
    const socket = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'session') {
          queueMicrotask(handler);
        }
        return socket;
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
      emit: vi.fn((event: string, callback: (data: unknown) => void) => {
        if (event === 'getJoinData') {
          callback({ users: [{ _id: userId, name: username }] });
        }
      }),
    };
    vi.mocked(io).mockReturnValue(socket as unknown as Socket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  function expectPrivateValuesAbsent(...values: string[]) {
    expect(output.some((line) => line.includes('DEBUG:'))).toBe(true);
    for (const value of [username, userId, password, session, ...values]) {
      expect(output.join('\n')).not.toContain(value);
    }
  }

  it('keeps display-name authentication credentials out of debug and success logs', async () => {
    await expect(
      authenticateFoundry('http://localhost:30000', username, password),
    ).resolves.toEqual({
      session,
      userId,
    });
    expect(output.some((line) => line.includes('authentication successful'))).toBe(true);
    expectPrivateValuesAbsent();
  });

  it('keeps a credential supplied as a document ID out of logs', async () => {
    const credential = '1234123412341234';
    await expect(
      authenticateFoundry('http://localhost:30000', credential, password),
    ).resolves.toEqual({
      session,
      userId: credential,
    });
    expect(io).not.toHaveBeenCalled();
    expectPrivateValuesAbsent(credential);
  });

  it('keeps missing-user errors and the available user list safe to log', async () => {
    const missingUser = 'private-missing-user';
    try {
      await authenticateFoundry('http://localhost:30000', missingUser, password);
      expect.fail('Authentication should reject an unknown user');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('FoundryVTT user not found');
      logger.error('Authentication rejected', error);
    }
    expectPrivateValuesAbsent(missingUser);
  });
});

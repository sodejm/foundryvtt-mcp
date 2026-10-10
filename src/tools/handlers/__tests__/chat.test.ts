/**
 * @fileoverview Unit tests for bounded chat reads
 */

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleGetChatMessages } from '../chat.js';
import { readMetadata } from './pagination-fixture.js';

interface MockChatMessage {
  _id: string;
  content: string;
  user: string;
  timestamp: number;
  speaker?: { alias?: string };
}

function buildMessages(count: number): MockChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `msg-${i}`,
    content: `message ${i}`,
    user: 'user-1',
    timestamp: Date.UTC(2024, 0, 1, 0, 0, i),
    speaker: { alias: `speaker-${i}` },
  }));
}

function mockFoundryClient(allMessages: MockChatMessage[]): FoundryClient {
  return {
    getReadMetadata: vi.fn(() => readMetadata()),
    getChatMessages: vi.fn((limit: number) => allMessages.slice(0, limit)),
    getUsers: vi.fn(() => ({ users: [{ _id: 'user-1', name: 'Alice' }] })),
  } as unknown as FoundryClient;
}

function countLines(result: Awaited<ReturnType<typeof handleGetChatMessages>>): number {
  const text =
    (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? '';
  // Header line is "**Recent Chat Messages** (N)\n\n<lines>"; count message lines after the header
  const body = text.split('\n\n').slice(1).join('\n\n').trim();
  if (body === '' || text.includes('No chat messages found.')) {
    return 0;
  }
  return body.split('\n').filter(Boolean).length;
}

describe('handleGetChatMessages — bounded limits', () => {
  it.each([
    0,
    -1,
    500,
    10_000,
    'all',
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
  ])('rejects invalid limit %s before reading world data', async (limit) => {
    const client = mockFoundryClient(buildMessages(1000));
    await expect(handleGetChatMessages({ limit }, client)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(client.getChatMessages).not.toHaveBeenCalled();
    expect(client.getUsers).not.toHaveBeenCalled();
    expect(client.getReadMetadata).not.toHaveBeenCalled();
  });

  it('uses default limit of 20 when no limit supplied', async () => {
    const client = mockFoundryClient(buildMessages(50));
    const result = await handleGetChatMessages({}, client);
    expect(countLines(result)).toBeLessThanOrEqual(20);
    expect(client.getChatMessages).toHaveBeenCalledWith(20);
  });

  it.each([1, 5, 100])('passes through valid limit %s unchanged', async (limit) => {
    const client = mockFoundryClient(buildMessages(50));
    await handleGetChatMessages({ limit }, client);
    expect(client.getChatMessages).toHaveBeenCalledWith(limit);
  });
});

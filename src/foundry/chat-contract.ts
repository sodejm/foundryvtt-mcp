import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** Validate before accessing chat history, including direct client reads. */
export function parseChatLimit(value: unknown = 20): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new McpError(ErrorCode.InvalidParams, 'Chat limit must be an integer between 1 and 100');
  }
  return value;
}

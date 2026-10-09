import { AsyncLocalStorage } from 'node:async_hooks';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { WorldData } from './types.js';

export type AuthorizationMode = 'service-identity' | 'delegated';

export interface TrustedCallerContext {
  callerId: string;
  userId: string;
  worldId: string;
  sessionId: string;
}

export type ReadSurface =
  | 'actors'
  | 'items'
  | 'journals'
  | 'chat'
  | 'users'
  | 'world-summary'
  | 'search'
  | 'scenes'
  | 'tokens'
  | 'combat'
  | 'compendia'
  | 'rules'
  | 'settings'
  | 'diagnostics';

export const DELEGATED_READ_SURFACES = new Set<ReadSurface>([
  'actors',
  'items',
  'journals',
  'chat',
  'users',
  'world-summary',
  'search',
]);

export const CALLER_AUTHORIZATION_MESSAGE = 'Caller is not authorized for this operation';

/** Deliberately carries no backend detail across the MCP trust boundary. */
export class CallerAuthorizationError extends McpError {
  constructor() {
    super(ErrorCode.InvalidRequest, CALLER_AUTHORIZATION_MESSAGE);
    this.name = 'CallerAuthorizationError';
  }
}

export interface AuthorizedCallerState {
  readonly context: Readonly<TrustedCallerContext>;
  readonly view: Readonly<WorldData>;
  readonly authorizationFingerprint: string;
  readonly capturedAt: string;
}

const CONTEXT_KEYS = ['callerId', 'userId', 'worldId', 'sessionId'] as const;

export function validateTrustedCallerContext(value: unknown): Readonly<TrustedCallerContext> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CallerAuthorizationError();
  }
  const entries = Object.keys(value);
  if (
    entries.length !== CONTEXT_KEYS.length ||
    entries.some((key) => !CONTEXT_KEYS.some((allowed) => allowed === key))
  ) {
    throw new CallerAuthorizationError();
  }
  const context = value as Record<string, unknown>;
  const result: TrustedCallerContext = {
    callerId: validatedContextValue(context.callerId),
    userId: validatedContextValue(context.userId),
    worldId: validatedContextValue(context.worldId),
    sessionId: validatedContextValue(context.sessionId),
  };
  return Object.freeze(result);
}

function validatedContextValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 256 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new CallerAuthorizationError();
  }
  return value;
}

export class CallerContextStorage {
  private readonly storage = new AsyncLocalStorage<AuthorizedCallerState>();

  run<T>(state: AuthorizedCallerState, operation: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(this.storage.run(state, operation));
  }

  getStore(): AuthorizedCallerState | undefined {
    return this.storage.getStore();
  }
}

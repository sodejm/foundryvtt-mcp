/**
 * FoundryVTT client for API communication via Socket.IO
 *
 * Connects to FoundryVTT using the proven 4-step authentication flow,
 * caches worldData in memory, and serves all queries from the snapshot.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import type {
  ActorItemListOutput,
  ActorItemOutput,
  ActorItemSummary,
  ActorSectionName,
  ActorSectionOutput,
  ActorSheetOutput,
} from './actor-sheet-contract.js';
import { ACTOR_SECTION_NAMES } from './actor-sheet-contract.js';
import {
  actorItemFields,
  actorSectionFields,
  actorSystemIdentity,
  isActorSectionSupported,
  publicActorIdentity,
  publicActorItemSummary,
} from './actor-sheet-profile.js';
import { authenticateFoundry, sessionSocketOptions } from './auth.js';
import {
  type AuthorizationMode,
  type AuthorizedCallerState,
  CallerAuthorizationError,
  CallerContextStorage,
  DELEGATED_READ_SURFACES,
  type ReadSurface,
  type TrustedCallerContext,
  validateTrustedCallerContext,
} from './caller-context.js';
import {
  type CapabilityReport,
  CONTENT_GENERATION_UNAVAILABLE,
  DIAGNOSTICS_UNAVAILABLE,
  RULES_LOOKUP_UNAVAILABLE,
} from './capabilities.js';
import { parseChatLimit } from './chat-contract.js';
import { compendiumParamsSchema } from './compendium-contract.js';
import { type DiceRollInput, diceRollOutputSchema, parseDiceRollInput } from './dice-contract.js';
import {
  evaluateParsedDiceFormula,
  InvalidDiceFormulaError,
  parseDiceFormula,
} from './dice-formula.js';
import type { WorldReadMetadata } from './freshness.js';
import { redactHtmlSecrets } from './html-secret-redaction.js';
import type { ItemEconomy } from './item-economy-contract.js';
import { itemEconomyAliases, restItemSystemIdentity } from './item-economy-read.js';
import {
  assertItemRarityFilter,
  type ItemEconomyIdentity,
  itemMatchesRarity,
  normalizeItemEconomy,
} from './item-normalization.js';
import {
  JOURNAL_DEFAULT_PAGE_LIMIT,
  JOURNAL_MAX_PAGE_LIMIT,
  JournalReadUnavailableError,
  journalContentChunks,
  journalPageSummary,
  prepareJournalRead,
} from './journal-read.js';
import {
  type CollectionPage,
  type CollectionRecord,
  type PaginationParams,
  SnapshotPaginator,
  sortCollectionRecords,
  validateBoundedText,
} from './pagination.js';
import {
  actorDocumentSchema,
  availableWorldReadMetadataSchema,
  FOUNDRY_ID_PATTERN,
  itemDocumentSchema,
} from './read-contract.js';
import { CompendiumRestAdapter } from './rest-compendium.js';
import { DiceRestAdapter } from './rest-dice.js';
import {
  projectSceneSpatial,
  type SceneIdentity,
  type SceneSpatialOutput,
  type SceneSpatialProjection,
  type SceneTokenListOutput,
  type SceneTokenOutput,
  type SceneTokenSummary,
} from './scene-spatial-contract.js';
import type {
  ActorAttributeUpdateResult,
  ActorItemCreateSource,
  ActorSearchResult,
  CompendiumSearchResult,
  DiceRoll,
  DocumentVisibility,
  FoundryActor,
  FoundryItem,
  FoundryScene,
  FoundryWorld,
  ItemSearchResult,
  JournalPageContent,
  JournalPageContentParams,
  JournalPageCreateSource,
  JournalSummaryPage,
  JournalSummaryPageParams,
  WorldActor,
  WorldCombat,
  WorldData,
  WorldEffect,
  WorldItem,
  WorldJournal,
  WorldMessage,
  WorldScene,
  WorldUser,
} from './types.js';
import { VISIBILITY_LEVELS } from './types.js';
import {
  applyDocumentBroadcast,
  applyUserActivity,
  type DocumentBroadcast,
  documentBroadcastRequiresRefresh,
  parseDocumentBroadcast,
  parseUserActivity,
  type UserActivity,
} from './world-cache.js';

const WORLD_DATA_UNAVAILABLE_MESSAGE = 'World data unavailable — no valid snapshot has been loaded';

const journalSummaryPageParamsSchema = z.strictObject({
  journalId: z.unknown(),
  limit: z.number().int().min(1).max(JOURNAL_MAX_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});

const journalPageContentParamsSchema = z.strictObject({
  journalId: z.unknown(),
  pageId: z.unknown(),
  format: z.enum(['text', 'source']).optional(),
  limit: z.number().int().min(1).max(JOURNAL_MAX_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});

function assertJournalReadId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !FOUNDRY_ID_PATTERN.test(id)) {
    throw new JournalReadUnavailableError();
  }
}

/** Validate identity before any detail lookup, including callers outside MCP. */
function assertReadId(id: unknown, field: string): asserts id is string {
  if (typeof id !== 'string' || !FOUNDRY_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${field} format: expected 16 alphanumeric characters`);
  }
}

const worldReadDocumentSchema = z.object({
  _id: z.string().regex(FOUNDRY_ID_PATTERN),
  name: z.string(),
  type: z.string(),
  img: z.string().optional(),
  system: z.record(z.string(), z.unknown()),
});

/** Wire shape returned by the REST bridge. Public MCP search results add
 * snapshot metadata after the complete backend result set has been verified. */
const restActorPageSchema = z.object({
  actors: z.array(actorDocumentSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  snapshotId: z.string().min(1).max(1024).optional(),
});

const restItemWireSchema = itemDocumentSchema.omit({ economy: true, price: true, rarity: true });
type NormalizedFoundryItem = FoundryItem & { economy: ItemEconomy };
const restItemPageSchema = z.object({
  items: z.array(restItemWireSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  snapshotId: z.string().min(1).max(1024).optional(),
});

/** Accept raw documents and the bridge's successful detail envelope. Identity
 * aliases must agree; a failed envelope must never become a document. */
function restDetailDocument(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const envelope = value as Record<string, unknown>;
  const document =
    'success' in envelope
      ? z.object({ success: z.literal(true), data: z.record(z.string(), z.unknown()) }).parse(value)
          .data
      : envelope;
  if (document.id !== undefined && document._id !== undefined && document.id !== document._id) {
    throw new Error('REST document identity aliases disagree');
  }
  return { ...document, _id: document._id ?? document.id };
}

/** REST module payloads do not establish UUID scope. Preserve existing internal
 * fields for other client callers, but remove unverified UUIDs before display. */
function restActor(value: unknown, expectedId?: string): FoundryActor {
  const { uuid: _uuid, ...actor } = actorDocumentSchema.parse(value);
  if (expectedId !== undefined && actor._id !== expectedId) {
    throw new Error('Actor response ID mismatch');
  }
  return actor as FoundryActor;
}
function restItem(
  value: unknown,
  identity: ItemEconomyIdentity = { id: 'unknown' },
  expectedId?: string,
): NormalizedFoundryItem {
  const {
    uuid: _uuid,
    economy: _economy,
    price: _price,
    rarity: _rarity,
    ...item
  } = restItemWireSchema.parse(value);
  if (expectedId !== undefined && item._id !== expectedId) {
    throw new Error('Item response ID mismatch');
  }
  const economy = normalizeItemEconomy(item, identity);
  return { ...item, economy, ...itemEconomyAliases(economy) } as NormalizedFoundryItem;
}

/**
 * True when a rejected request carries an HTTP response — FoundryVTT answered,
 * whatever the status. A rejection without one is a transport failure
 * (connection refused or reset, DNS, timeout): the server is not reachable.
 *
 * Read reflectively rather than cast, so a non-axios rejection cannot be
 * mistaken for a reply.
 */
function hasHttpResponse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const response = Reflect.get(error, 'response');
  return response !== undefined && response !== null;
}

/** Normalizes Foundry timestamps without inventing a new observation time on reads. */
function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

/**
 * Spacing between sibling `sort` values, mirroring Foundry's
 * `CONST.SORT_INTEGER_DENSITY`. Leaving every sibling at the default `0` makes
 * ordering depend on incidental collection insertion order, and gives Foundry
 * no gap to slot a UI-created sibling into later.
 */
const SORT_INTEGER_DENSITY = 100000;

/**
 * Accepts the two parent-UUID forms a token's actor can take:
 *  - `Actor.<id>` — a world-linked actor (`actorLink: true`)
 *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` — an unlinked token's synthetic actor
 */
const TOKEN_ACTOR_UUID_PATTERN =
  /^(Actor\.[a-zA-Z0-9]{16}|Scene\.[a-zA-Z0-9]{16}\.Token\.[a-zA-Z0-9]{16}\.Actor\.[a-zA-Z0-9]{16})$/;

/**
 * Minimal Zod schema for the WorldData Socket.IO payload.
 * Validates the required top-level array fields; extra fields pass through.
 */
const WorldDataSchema = z
  .object({
    userId: z.string().min(1),
    release: z.record(z.string(), z.unknown()),
    world: z.object({ id: z.string().min(1) }).passthrough(),
    system: z.object({ id: z.string().min(1) }).passthrough(),
    modules: z.array(z.record(z.string(), z.unknown())),
    demoMode: z.boolean(),
    actors: z.array(z.unknown()),
    scenes: z.array(z.unknown()),
    items: z.array(z.unknown()),
    journal: z.array(z.unknown()),
    messages: z.array(z.unknown()),
    combats: z.array(z.unknown()),
    users: z.array(z.unknown()),
    activeUsers: z.array(z.string()),
    settings: z.array(z.unknown()),
    macros: z.array(z.unknown()),
    playlists: z.array(z.unknown()),
    tables: z.array(z.unknown()),
    folders: z.array(z.unknown()),
    cards: z.array(z.unknown()),
    packs: z.array(z.unknown()),
  })
  .passthrough();

const MAX_REFRESH_EVENT_BUFFER = 1000;
const OBSERVER_PERMISSION = 2;
const GAMEMASTER_ROLE = 3;
const INHERIT_PERMISSION = -1;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function permissionLevel(ownership: unknown, userId: string, inheritedLevel?: number): number {
  if (ownership === undefined) {
    return inheritedLevel ?? 0;
  }
  if (typeof ownership !== 'object' || ownership === null || Array.isArray(ownership)) {
    return 0;
  }
  const record = ownership as Record<string, unknown>;
  const raw = Object.hasOwn(record, userId)
    ? record[userId]
    : Object.hasOwn(record, 'default')
      ? record.default
      : INHERIT_PERMISSION;
  if (!Number.isInteger(raw) || (raw as number) < INHERIT_PERMISSION || (raw as number) > 3) {
    return 0;
  }
  return raw === INHERIT_PERMISSION ? (inheritedLevel ?? 0) : (raw as number);
}

function ownershipIsValid(ownership: unknown): boolean {
  if (ownership === undefined) {
    return true;
  }
  if (typeof ownership !== 'object' || ownership === null || Array.isArray(ownership)) {
    return false;
  }
  return Object.entries(ownership).every(
    ([key, level]) =>
      key.length > 0 &&
      Number.isInteger(level) &&
      (level as number) >= INHERIT_PERMISSION &&
      (level as number) <= 3,
  );
}

function canObserve(ownership: unknown, user: WorldUser, inheritedLevel?: number): boolean {
  if (ownership === undefined && inheritedLevel === undefined) {
    return false;
  }
  if (!ownershipIsValid(ownership)) {
    return false;
  }
  return (
    user.role >= GAMEMASTER_ROLE ||
    permissionLevel(ownership, user._id, inheritedLevel) >= OBSERVER_PERMISSION
  );
}

function sanitizeUser(user: WorldUser, visibleActorIds: ReadonlySet<string>): WorldUser {
  const sanitized: WorldUser = {
    _id: user._id,
    name: user.name,
    role: user.role,
    color: user.color,
  };
  if (user.avatar !== undefined) {
    sanitized.avatar = user.avatar;
  }
  if (user.character !== undefined && visibleActorIds.has(user.character)) {
    sanitized.character = user.character;
  }
  if (user.pronouns !== undefined) {
    sanitized.pronouns = user.pronouns;
  }
  return sanitized;
}

function canReadChatMessage(message: WorldMessage, user: WorldUser): boolean {
  const author = message.author ?? message.user;
  if (typeof author !== 'string' || author.length === 0) {
    return false;
  }
  if (message.blind !== undefined && typeof message.blind !== 'boolean') {
    return false;
  }
  let whisper: string[];
  if (message.whisper === undefined) {
    whisper = [];
  } else if (
    !Array.isArray(message.whisper) ||
    message.whisper.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    return false;
  } else {
    whisper = message.whisper;
  }
  if (author === user._id) {
    return message.blind !== true || user.role >= GAMEMASTER_ROLE;
  }
  return message.blind === true
    ? whisper.includes(user._id)
    : whisper.length === 0 || whisper.includes(user._id);
}

function canReadItemIdentity(item: WorldItem, user: WorldUser): boolean {
  if (user.role >= GAMEMASTER_ROLE) {
    return true;
  }
  if (item.system.identified === false) {
    return false;
  }
  const identification = item.system.identification;
  if (typeof identification === 'object' && identification !== null) {
    const status = Reflect.get(identification, 'status');
    if (status !== undefined && status !== 'identified') {
      return false;
    }
  }
  return true;
}

function projectItem(item: WorldItem, user: WorldUser): WorldItem {
  const result = cloneValue(item);
  if (user.role < GAMEMASTER_ROLE) {
    const description = result.system.description;
    if (typeof description === 'object' && description !== null && !Array.isArray(description)) {
      const value = Reflect.get(description, 'value');
      if (typeof value === 'string') {
        Reflect.set(description, 'value', redactHtmlSecrets(value));
      }
    }
  }
  return result;
}

function projectWorldData(source: WorldData, user: WorldUser, surface: ReadSurface): WorldData {
  const includes = (requested: ReadSurface) => surface === 'search' || surface === requested;
  const actors = (includes('actors') ? source.actors : [])
    .filter((actor) => canObserve(actor.ownership, user))
    .map((actor) => {
      const actorLevel = permissionLevel(actor.ownership, user._id);
      const result = cloneValue(actor);
      if (user.role < GAMEMASTER_ROLE) {
        const details = result.system.details;
        if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
          const biography = Reflect.get(details, 'biography');
          if (typeof biography === 'object' && biography !== null && !Array.isArray(biography)) {
            const value = Reflect.get(biography, 'value');
            if (typeof value === 'string') {
              Reflect.set(biography, 'value', redactHtmlSecrets(value));
            }
          }
        }
      }
      if (Array.isArray(result.items)) {
        result.items = result.items
          .filter(
            (item) =>
              canObserve(item.ownership, user, actorLevel) && canReadItemIdentity(item, user),
          )
          .map((item) => projectItem(item, user));
      }
      return result;
    });
  const items = (includes('items') ? source.items : [])
    .filter((item) => canObserve(item.ownership, user) && canReadItemIdentity(item, user))
    .map((item) => projectItem(item, user));
  const journal = (includes('journals') ? source.journal : [])
    .filter((entry) => canObserve(entry.ownership, user))
    .map((entry) => {
      const entryLevel = permissionLevel(entry.ownership, user._id);
      const result = cloneValue(entry);
      if (Array.isArray(result.pages)) {
        result.pages = result.pages.filter((page) => canObserve(page.ownership, user, entryLevel));
        if (user.role < GAMEMASTER_ROLE) {
          for (const page of result.pages) {
            if (page.text) {
              for (const field of ['content', 'markdown'] as const) {
                const source = page.text[field];
                if (typeof source === 'string') {
                  page.text[field] = redactHtmlSecrets(source);
                }
              }
            }
          }
        }
      }
      return result;
    });
  const messages = (includes('chat') ? source.messages : [])
    .filter((message) => canReadChatMessage(message, user))
    .map((message) => {
      const result = cloneValue(message);
      result.user = message.author ?? message.user;
      return result;
    });
  const ownUser = sanitizeUser(
    user,
    new Set(
      source.actors.filter((actor) => canObserve(actor.ownership, user)).map((actor) => actor._id),
    ),
  );
  return {
    userId: user._id,
    release: cloneValue(source.release),
    world: cloneValue(source.world),
    system: cloneValue(source.system),
    modules: [],
    demoMode: source.demoMode,
    actors,
    scenes: [],
    items,
    journal,
    messages,
    combats: [],
    users: [ownUser],
    activeUsers: source.activeUsers.includes(user._id) ? [user._id] : [],
    settings: [],
    macros: [],
    playlists: [],
    tables: [],
    folders: [],
    cards: [],
    packs: [],
  };
}

type BufferedWorldEvent =
  | { kind: 'document'; value: DocumentBroadcast }
  | { kind: 'activity'; value: UserActivity };

interface RefreshBuffer {
  generation: number;
  epoch: number;
  events: BufferedWorldEvent[];
  overflowed: boolean;
}

export interface FoundryClientConfig {
  baseUrl: string;
  apiKey?: string;
  restUrl?: string;
  restApiKey?: string;
  restClientId?: string;
  username?: string;
  password?: string;
  userId?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  socketPath?: string;
  /** Opt-in gate for game-state mutations (FOUNDRY_WRITE_ENABLED). Default false. */
  writeEnabled?: boolean;
  /** Authorization boundary for public reads. Default preserves service-identity behavior. */
  authorizationMode?: AuthorizationMode;
}

/** Minimal shape of FoundryVTT's `modifyDocument` Socket.IO acknowledgement. */
interface DocumentSocketResponse {
  /** Created/updated data objects, or deleted ids, on success. */
  result?: unknown[];
  /** Present when the server rejects the operation. */
  error?: { message?: string } | null;
  userId?: string;
}

export interface SearchActorsParams {
  query?: string;
  type?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchItemsParams {
  query?: string;
  type?: string;
  rarity?: string;
  limit?: number;
  cursor?: string;
}

export interface ListActorItemsParams {
  actorId: string;
  query?: string;
  type?: string;
  limit?: number;
  cursor?: string;
}

export interface ListSceneTokensParams {
  sceneId?: string;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchCollectionParams {
  query?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface CompendiumSearchParams {
  query?: string | undefined;
  packType?: string | undefined;
  itemType?: string | undefined;
  spellLevel?: number | undefined;
  source?: string | undefined;
  compendiumId?: string | undefined;
  limit?: number | undefined;
  /** Opaque pagination cursor from a prior result's `nextCursor`. */
  cursor?: string | undefined;
}

/**
 * Shallow attribute patch for {@link FoundryClient.updateActorAttribute} (#143).
 *
 * Keys are dot-paths into the actor's `system` object (e.g.
 * `attributes.hp.value`, `currency.gp`, `spells.spell1.value`,
 * `attributes.exhaustion`). Values are the scalar to set at that path.
 */
export type AttributePatch = Record<string, number | string | boolean>;

export class FoundryClient {
  private http: AxiosInstance;
  private socket: Socket | null = null;
  private config: FoundryClientConfig;
  private _isConnected = false;
  private worldData: WorldData | null = null;
  /** Set when the socket drops with a cache still loaded (#217). */
  private worldDataStale = false;
  /**
   * Last observed outcome of a REST request: false once one failed to reach
   * FoundryVTT at all (#217). Unused in Socket.IO mode.
   */
  private restLinkLive = true;
  private readonly paginator = new SnapshotPaginator();
  private readonly compendiumPaginator = new SnapshotPaginator();
  private compendiumRelayIdentity = randomUUID();
  private compendiumRelayConfig: {
    restUrl: string | undefined;
    restClientId: string | undefined;
    restApiKey: string | undefined;
  } | null = null;
  private readonly sceneTokenPaginator = new SnapshotPaginator();
  private readonly compendiumAdapter: CompendiumRestAdapter;
  private paginationSession = randomUUID();
  private restStatusIdentity = 'not-connected';
  private readSessionId = randomUUID();
  private snapshotId: string | null = null;
  private snapshotRevision = 0;
  private snapshotCapturedAt: string | null = null;
  private snapshotObservedAt: string | null = null;
  private snapshotWorldId: string | null = null;
  private restRevision = 0;
  private restObservedAt: string | null = null;
  private restWorldId: string | null = null;
  private socketGeneration = 0;
  private socketEpoch = 0;
  private socketUserId: string | null = null;
  private refreshInFlight: {
    socket: Socket;
    generation: number;
    epoch: number;
    promise: Promise<void>;
  } | null = null;
  private refreshBuffer: RefreshBuffer | null = null;
  private readonly pendingWorldRequests = new Set<(error: Error) => void>();
  private readonly callerContext = new CallerContextStorage();

  constructor(config: FoundryClientConfig) {
    if (!config.baseUrl || config.baseUrl.trim() === '') {
      throw new Error('baseUrl is required and cannot be empty');
    }

    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error(`Invalid baseUrl: ${config.baseUrl}`);
    }

    this.config = {
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      socketPath: '/socket.io/',
      authorizationMode: 'service-identity',
      ...config,
    };
    if (!['service-identity', 'delegated'].includes(this.config.authorizationMode ?? '')) {
      throw new Error('authorizationMode must be service-identity or delegated');
    }

    this.compendiumAdapter = new CompendiumRestAdapter({
      baseUrl: this.config.restUrl,
      clientId: this.config.restClientId,
      apiKey: this.config.restApiKey,
      timeout: this.config.timeout,
    });
    this.http = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FoundryMCP/0.2.0',
      },
      maxRedirects: 3,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    if (this.config.apiKey) {
      this.http.interceptors.request.use((reqConfig) => {
        reqConfig.headers['x-api-key'] = this.config.apiKey;
        return reqConfig;
      });

      // REST mode has no socket to ask about liveness, so every request that
      // does happen doubles as the probe (#217). See `isConnected()`.
      this.http.interceptors.response.use(
        (response) => {
          this.restLinkLive = true;
          this.observeRestResponse(response.data);
          return response;
        },
        (error: unknown) => {
          this.restLinkLive = hasHttpResponse(error);
          if (this.restLinkLive) {
            this.observeRestResponse(Reflect.get(error as object, 'response'));
          }
          return Promise.reject(error);
        },
      );
    }

    const mode = this.config.apiKey ? 'REST API' : 'Socket.IO';
    logger.info(`FoundryVTT client initialized (${mode} mode)`);
  }

  isDelegatedMode(): boolean {
    return this.config.authorizationMode === 'delegated';
  }

  assertReadSurfaceAllowed(surface: ReadSurface): void {
    if (!this.isDelegatedMode()) {
      return;
    }
    if (!DELEGATED_READ_SURFACES.has(surface)) {
      throw new CallerAuthorizationError();
    }
    this.requireDelegatedState();
  }

  private requireDelegatedState(): AuthorizedCallerState {
    const state = this.callerContext.getStore();
    if (!state || !this.connectionIsLive()) {
      throw new CallerAuthorizationError();
    }
    return state;
  }

  private readWorld(surface: ReadSurface): WorldData {
    if (!this.isDelegatedMode()) {
      return this.requireWorldData();
    }
    if (!DELEGATED_READ_SURFACES.has(surface)) {
      throw new CallerAuthorizationError();
    }
    return this.requireDelegatedState().getWorldView(surface) as WorldData;
  }

  async runWithCaller<T>(
    context: TrustedCallerContext,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.isDelegatedMode()) {
      return await operation();
    }
    let state: AuthorizedCallerState;
    try {
      const validated = validateTrustedCallerContext(context);
      if (this.config.apiKey) {
        throw new CallerAuthorizationError();
      }
      const socket = this.socket;
      if (!socket?.connected || !this._isConnected) {
        throw new CallerAuthorizationError();
      }
      const generation = this.socketGeneration;
      const epoch = this.socketEpoch;
      const parsed = WorldDataSchema.safeParse(
        await this.requestWorldSnapshot(socket, generation, epoch),
      );
      if (
        !parsed.success ||
        !this.isCurrentSocket(socket, generation, epoch) ||
        !socket.connected
      ) {
        throw new CallerAuthorizationError();
      }
      const snapshot = cloneValue(parsed.data) as unknown as WorldData;
      if (snapshot.userId !== this.socketUserId || snapshot.world.id !== validated.worldId) {
        throw new CallerAuthorizationError();
      }
      const matchingUsers = snapshot.users.filter((entry) => entry._id === validated.userId);
      const caller = matchingUsers.length === 1 ? matchingUsers[0] : undefined;
      if (
        !caller ||
        !Number.isInteger(caller.role) ||
        caller.role <= 0 ||
        caller.role > 4 ||
        typeof caller.name !== 'string' ||
        caller.name.length === 0 ||
        typeof caller.color !== 'string'
      ) {
        throw new CallerAuthorizationError();
      }
      const views = new Map<ReadSurface, Readonly<WorldData>>();
      const fingerprints = new Map<ReadSurface, string>();
      let spatialView: Readonly<SceneSpatialProjection> | undefined;
      const project = <V>(operation: () => V): V => {
        try {
          return operation();
        } catch {
          throw new CallerAuthorizationError();
        }
      };
      const getWorldView = (surface: ReadSurface): Readonly<WorldData> =>
        project(() => {
          let view = views.get(surface);
          if (!view) {
            view = deepFreeze(projectWorldData(snapshot, caller, surface));
            views.set(surface, view);
          }
          return view;
        });
      const getSpatialView = (): Readonly<SceneSpatialProjection> =>
        project(() => {
          spatialView ??= deepFreeze(projectSceneSpatial(snapshot, caller));
          return spatialView;
        });
      state = Object.freeze({
        context: validated,
        getWorldView,
        getSpatialView,
        fingerprintFor: (surface: ReadSurface) =>
          project(() => {
            let fingerprint = fingerprints.get(surface);
            if (!fingerprint) {
              const view = surface === 'scene-spatial' ? getSpatialView() : getWorldView(surface);
              fingerprint = createHash('sha256')
                .update(JSON.stringify({ context: validated, surface, view }))
                .digest('hex');
              fingerprints.set(surface, fingerprint);
            }
            return fingerprint;
          }),
        getSummary: () =>
          project(() =>
            Object.freeze({
              actors: snapshot.actors.filter((actor) => canObserve(actor.ownership, caller)).length,
              items: snapshot.items.filter(
                (item) => canObserve(item.ownership, caller) && canReadItemIdentity(item, caller),
              ).length,
              journals: snapshot.journal.filter((entry) => canObserve(entry.ownership, caller))
                .length,
              users: 1,
              messages: snapshot.messages.filter((message) => canReadChatMessage(message, caller))
                .length,
            }),
          ),
        snapshotId: randomUUID(),
        capturedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof CallerAuthorizationError) {
        throw error;
      }
      throw new CallerAuthorizationError();
    }
    return await this.callerContext.run(state, operation);
  }

  /**
   * Connects to FoundryVTT.
   * REST API mode: tests /api/status endpoint.
   * Socket.IO mode: authenticates and loads full worldData.
   */
  async connect(): Promise<void> {
    if (this.config.apiKey) {
      try {
        const response = await this.http.get('/api/status');
        this.resetPaginationSession();
        this.restStatusIdentity = JSON.stringify(response.data ?? null);
        this._isConnected = true;
        logger.info('Connected to FoundryVTT via REST API module');
      } catch (error) {
        logger.error('Failed to connect via REST API module:', error);
        throw error;
      }
      return;
    }

    const user = this.config.userId || this.config.username;
    if (!user || this.config.password === undefined) {
      throw new Error(
        'Socket.IO mode requires username/userId and password. ' +
          'Set FOUNDRY_USERNAME + FOUNDRY_PASSWORD or FOUNDRY_USER_ID + FOUNDRY_PASSWORD.',
      );
    }

    const { session } = await authenticateFoundry(this.config.baseUrl, user, this.config.password);

    const worldData = await this.connectAndLoadWorld(session);
    logger.info('Connected to FoundryVTT via Socket.IO', {
      actors: worldData.actors.length,
      scenes: worldData.scenes.length,
      items: worldData.items.length,
    });
  }

  /**
   * Connects Socket.IO with an authenticated session and loads worldData.
   */
  private connectAndLoadWorld(session: string): Promise<WorldData> {
    this.detachSocket();
    this.rotateReadSession();
    this.clearSocketSnapshot();

    return new Promise((resolve, reject) => {
      const socket = io(this.config.baseUrl, sessionSocketOptions(session));
      this.socket = socket;
      const generation = ++this.socketGeneration;
      const epoch = ++this.socketEpoch;
      let settled = false;

      const cleanup = () => {
        socket.off('session', onSession);
        socket.off('connect_error', onConnectError);
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cleanup();
        if (this.socket === socket) {
          this.detachSocket();
        }
        reject(error);
      };

      const timeout = setTimeout(() => {
        fail(new Error(`Timeout waiting for authenticated session (${this.config.timeout}ms)`));
      }, this.config.timeout);

      const onSession = async (data: { userId?: string } | null) => {
        if (settled || !this.isCurrentSocket(socket, generation, epoch)) {
          return;
        }
        if (!data?.userId) {
          fail(new Error('Authentication failed — session event returned no userId'));
          return;
        }

        clearTimeout(timeout);
        cleanup();
        this.socketUserId = data.userId;
        this._isConnected = true;
        this.attachSocketListeners(socket);
        try {
          await this.refreshWorldDataInternal();
          if (settled || !this.isCurrentSocket(socket, generation, epoch)) {
            return;
          }
          settled = true;
          resolve(this.requireWorldData());
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onConnectError = (err: Error) => {
        fail(new Error(`Socket.IO connection failed: ${err.message}`));
      };

      socket.on('session', onSession);
      socket.on('connect_error', onConnectError);
    });
  }

  private attachSocketListeners(socket: Socket): void {
    socket.on('modifyDocument', this.onDocumentBroadcast);
    socket.on('userActivity', this.onUserActivity);
    socket.on('connect', this.onSocketConnect);
    socket.on('disconnect', this.onSocketDisconnect);
    socket.on('session', this.onSocketSession);
  }

  private isCurrentSocket(socket: Socket, generation: number, epoch: number): boolean {
    return (
      this.socket === socket && this.socketGeneration === generation && this.socketEpoch === epoch
    );
  }

  private cancelWorldRequests(error: Error): void {
    for (const cancel of this.pendingWorldRequests) {
      cancel(error);
    }
    this.pendingWorldRequests.clear();
  }

  private clearSocketSnapshot(): void {
    this.worldData = null;
    this.worldDataStale = false;
    this.snapshotId = null;
    this.snapshotRevision = 0;
    this.snapshotCapturedAt = null;
    this.snapshotObservedAt = null;
    this.snapshotWorldId = null;
  }

  private requireWorldData(): WorldData {
    if (!this.worldData) {
      throw new Error(WORLD_DATA_UNAVAILABLE_MESSAGE);
    }
    return this.worldData;
  }

  private publishWorldData(data: WorldData): void {
    const nextWorldId = data.world.id;
    if (this.snapshotWorldId !== null && this.snapshotWorldId !== nextWorldId) {
      this.rotateReadSession();
      this.snapshotRevision = 0;
    }
    const now = new Date().toISOString();
    this.worldData = data;
    this.worldDataStale = false;
    this.snapshotWorldId = nextWorldId;
    this.snapshotId = randomUUID();
    this.snapshotRevision += 1;
    this.snapshotCapturedAt = now;
    this.snapshotObservedAt = now;
  }

  private noteSnapshotMutation(): void {
    if (!this.worldData || !this.snapshotId) {
      return;
    }
    this.snapshotId = randomUUID();
    this.snapshotRevision += 1;
    this.snapshotObservedAt = new Date().toISOString();
  }

  /**
   * Applies a FoundryVTT `modifyDocument` broadcast to the cached world state (#205).
   *
   * Bound field rather than a method so the same reference can be passed to
   * `socket.off()` on teardown. Never throws: a malformed or unmodelled payload
   * leaves the cache untouched rather than taking the connection down.
   */
  private onDocumentBroadcast = (payload: unknown): void => {
    const broadcast = parseDocumentBroadcast(payload);
    if (!broadcast) {
      return;
    }
    this.bufferRefreshEvent({ kind: 'document', value: broadcast });
    if (!this.worldData) {
      return;
    }

    try {
      const applied = applyDocumentBroadcast(this.worldData, broadcast);
      if (documentBroadcastRequiresRefresh(this.worldData, broadcast)) {
        this.worldDataStale = true;
      }
      if (applied) {
        this.noteSnapshotMutation();
      }
      logger.debug(
        applied
          ? `Applied ${broadcast.action} ${broadcast.type} broadcast to cached worldData`
          : `Ignored ${broadcast.action} ${broadcast.type} broadcast (not cached)`,
      );
    } catch (error) {
      this.worldDataStale = true;
      logger.warn('Failed to apply document broadcast to cached worldData', {
        type: broadcast.type,
        action: broadcast.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Applies a FoundryVTT `userActivity` broadcast to cached presence (#218).
   *
   * Foundry emits this on login, on logout, and on ordinary activity, and it is
   * the only signal that moves `worldData.activeUsers` — that field is a
   * top-level `WorldData` entry, not a document collection, so the
   * `modifyDocument` path never touches it and `get_users` would otherwise
   * answer "who is connected?" from the connect-time snapshot forever.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   * Never throws: an unrecognized payload leaves presence as it was.
   */
  private onUserActivity = (userId: unknown, activityData?: unknown): void => {
    const activity = parseUserActivity(userId, activityData);
    if (!activity) {
      logger.debug('Ignored unrecognized userActivity payload');
      return;
    }
    this.bufferRefreshEvent({ kind: 'activity', value: activity });
    if (!this.worldData) {
      return;
    }

    if (applyUserActivity(this.worldData, activity)) {
      this.noteSnapshotMutation();
      logger.debug(
        `User ${activity.userId} is now ${activity.active ? 'active' : 'inactive'} (userActivity)`,
      );
    }
  };

  /**
   * Reacts to socket.io bringing the link back up on its own (#217).
   *
   * `sessionSocketOptions` leaves socket.io-client's default
   * `reconnection: true` in place, so after a transient drop the manager
   * re-handshakes the SAME socket instance (the session cookie rides along in
   * `extraHeaders`) and the persistent `modifyDocument`/`userActivity`
   * listeners resume firing. Without this the connected flag would stay
   * latched off for the rest of the process while writes and broadcasts were
   * demonstrably working again.
   *
   * Retained data stays stale while automatic snapshot recovery runs. Only a
   * validated snapshot with buffered events replayed restores current reads.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onSocketConnect = (): void => {
    if (!this.socket) {
      return;
    }
    this.socketEpoch += 1;
    this.cancelWorldRequests(new Error('Socket connection epoch changed'));
    this.refreshInFlight = null;
    this.refreshBuffer = null;
    this.resetPaginationSession();
    this._isConnected = true;
    this.worldDataStale = this.worldData !== null;
    void this.refreshWorldDataInternal().catch((error: unknown) => {
      logger.warn('Automatic world snapshot recovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    logger.info('FoundryVTT socket reconnected — refreshing cached world data');
  };

  /** Retain stale data during an outage and invalidate traversal and pending ACKs. */
  private onSocketDisconnect = (reason?: unknown): void => {
    this.socketEpoch += 1;
    this.cancelWorldRequests(new Error('Socket disconnected during world refresh'));
    this.refreshInFlight = null;
    this.refreshBuffer = null;
    this.resetPaginationSession();
    this._isConnected = false;
    this.worldDataStale = this.worldData !== null;
    logger.warn('FoundryVTT socket disconnected — cached world data is now stale', {
      reason: typeof reason === 'string' ? reason : undefined,
    });
  };

  private onSocketSession = (data: { userId?: string } | null): void => {
    if (!data?.userId || data.userId === this.socketUserId) {
      return;
    }
    this.socketUserId = data.userId;
    this.socketEpoch += 1;
    this.cancelWorldRequests(new Error('Authenticated socket session changed'));
    this.refreshInFlight = null;
    this.refreshBuffer = null;
    this.rotateReadSession();
    this.clearSocketSnapshot();
    if (this.socket?.connected) {
      void this.refreshWorldDataInternal().catch((error: unknown) => {
        logger.warn('World snapshot load after session change failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  private bufferRefreshEvent(event: BufferedWorldEvent): void {
    const buffer = this.refreshBuffer;
    if (
      !buffer ||
      buffer.generation !== this.socketGeneration ||
      buffer.epoch !== this.socketEpoch
    ) {
      return;
    }
    if (buffer.events.length >= MAX_REFRESH_EVENT_BUFFER) {
      buffer.overflowed = true;
      return;
    }
    buffer.events.push(event);
  }

  /**
   * Closes the current socket and removes every persistent listener bound to
   * it. Used both by `disconnect()` and before a socket is replaced: a
   * superseded socket that kept its `disconnect` handler would otherwise clear
   * the connected flag of the live socket that replaced it when it finally
   * closed (`DiagnosticsClient.testAuthentication()` re-connects a live
   * client, so this is reachable in-repo).
   */
  private detachSocket(): void {
    const socket = this.socket;
    this.socketGeneration += 1;
    this.socketEpoch += 1;
    this.cancelWorldRequests(new Error('Socket retired'));
    this.refreshInFlight = null;
    this.refreshBuffer = null;
    this.socketUserId = null;
    if (!socket) {
      return;
    }
    socket.off('modifyDocument', this.onDocumentBroadcast);
    socket.off('userActivity', this.onUserActivity);
    socket.off('connect', this.onSocketConnect);
    socket.off('disconnect', this.onSocketDisconnect);
    socket.off('session', this.onSocketSession);
    socket.disconnect();
    this.socket = null;
  }

  async disconnect(): Promise<void> {
    this.detachSocket();
    this.rotateReadSession();
    this.clearSocketSnapshot();
    this._isConnected = false;
    this.restLinkLive = true;
    logger.info('FoundryVTT client disconnected');
  }

  private resetPaginationSession(): void {
    this.paginator.clear();
    this.compendiumPaginator.clear();
    this.sceneTokenPaginator.clear();
    this.paginationSession = randomUUID();
  }

  private rotateReadSession(): void {
    this.readSessionId = randomUUID();
    this.resetPaginationSession();
  }

  private observeRestResponse(value: unknown): void {
    this.restObservedAt = new Date().toISOString();
    this.restRevision += 1;
    const candidate =
      typeof value === 'object' && value !== null && 'data' in value
        ? Reflect.get(value, 'data')
        : value;
    if (typeof candidate !== 'object' || candidate === null) {
      return;
    }
    const world = Reflect.get(candidate, 'world');
    const directWorldId = Reflect.get(candidate, 'worldId');
    const nestedWorldId =
      typeof world === 'object' && world !== null ? Reflect.get(world, 'id') : undefined;
    const nextWorldId =
      typeof directWorldId === 'string'
        ? directWorldId
        : typeof nestedWorldId === 'string'
          ? nestedWorldId
          : null;
    if (nextWorldId && this.restWorldId && nextWorldId !== this.restWorldId) {
      this.rotateReadSession();
    }
    if (nextWorldId) {
      this.restWorldId = nextWorldId;
    }
  }

  /** Non-throwing diagnostics for the source snapshot used by world reads. */
  getReadMetadata(): WorldReadMetadata {
    const respondedAt = new Date().toISOString();
    if (this.isDelegatedMode()) {
      const state = this.requireDelegatedState();
      return {
        source: 'socket',
        freshness: 'current',
        worldId: state.context.worldId,
        sessionId: state.context.sessionId,
        snapshotId: state.snapshotId,
        revision: 1,
        capturedAt: state.capturedAt,
        observedAt: state.capturedAt,
        respondedAt,
      };
    }
    if (this.config.apiKey) {
      return {
        source: 'rest',
        freshness:
          this.restObservedAt === null ? 'unavailable' : this.isConnected() ? 'current' : 'stale',
        worldId: this.restWorldId,
        sessionId: this.readSessionId,
        snapshotId: null,
        revision: this.restRevision,
        capturedAt: null,
        observedAt: this.restObservedAt,
        respondedAt,
      };
    }
    return {
      source: 'socket',
      freshness:
        this.snapshotId === null
          ? 'unavailable'
          : this.worldDataStale || !this.isConnected()
            ? 'stale'
            : 'current',
      worldId: this.snapshotWorldId,
      sessionId: this.readSessionId,
      snapshotId: this.snapshotId,
      revision: this.snapshotRevision,
      capturedAt: this.snapshotCapturedAt,
      observedAt: this.snapshotObservedAt,
      respondedAt,
    };
  }

  private getAvailableReadMetadata(): WorldReadMetadata & {
    freshness: 'current' | 'stale';
  } {
    const metadata = this.getReadMetadata();
    if (metadata.freshness === 'unavailable') {
      throw new Error(WORLD_DATA_UNAVAILABLE_MESSAGE);
    }
    return { ...metadata, freshness: metadata.freshness };
  }

  /**
   * Reports whether the client currently has a live link to FoundryVTT (#217).
   *
   * Socket.IO mode answers from the socket itself rather than from a latched
   * flag, so a link that dropped without an explicit `disconnect()` — server
   * restart, network loss — reads as disconnected immediately, even if the
   * `disconnect` event has not been delivered yet. It tracks the socket in both
   * directions: an automatic reconnect (`onSocketConnect`) reads as connected
   * again rather than staying latched off.
   *
   * REST API mode (`FOUNDRY_API_KEY`) has no socket to ask, so it answers from
   * the last REST request that actually happened: a request that failed to
   * reach FoundryVTT (connection refused, reset, timed out) reads as
   * disconnected from then on, and the next request that gets through reads as
   * connected again. An HTTP error status does not count as a drop — the
   * server answered. This is a *last observed outcome*, not a live probe: it
   * cannot notice a server that went away between requests, and it never does
   * I/O of its own, because this accessor is synchronous and widely called.
   */
  isConnected(): boolean {
    if (this.isDelegatedMode()) {
      this.assertReadSurfaceAllowed('diagnostics');
    }
    return this.connectionIsLive();
  }

  private connectionIsLive(): boolean {
    if (this.config.apiKey) {
      return this._isConnected && this.restLinkLive;
    }
    return this._isConnected && this.socket?.connected === true;
  }

  /**
   * True when the cached snapshot is no longer being kept live by broadcasts —
   * i.e. the socket dropped after a world load (#217). Reads still answer from
   * the cache; this flags that the answer is a point-in-time copy.
   */
  isWorldDataStale(): boolean {
    this.assertReadSurfaceAllowed('diagnostics');
    return this.worldDataStale;
  }

  /**
   * Returns true if worldData is available (Socket.IO mode connected).
   */
  hasWorldData(): boolean {
    this.assertReadSurfaceAllowed('diagnostics');
    return this.worldData !== null;
  }

  // ==========================================================================
  // World data accessors
  // ==========================================================================

  async refreshWorldData(): Promise<void> {
    if (this.isDelegatedMode()) {
      throw new CallerAuthorizationError();
    }
    return this.refreshWorldDataInternal();
  }

  private async refreshWorldDataInternal(): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected) {
      throw new Error('Not connected — cannot refresh world data');
    }
    const generation = this.socketGeneration;
    const epoch = this.socketEpoch;
    if (
      this.refreshInFlight &&
      this.refreshInFlight.socket === socket &&
      this.refreshInFlight.generation === generation &&
      this.refreshInFlight.epoch === epoch
    ) {
      return this.refreshInFlight.promise;
    }

    if (this.worldData) {
      this.worldDataStale = true;
    }
    const buffer: RefreshBuffer = { generation, epoch, events: [], overflowed: false };
    this.refreshBuffer = buffer;
    const promise = this.runWorldRefresh(socket, generation, epoch, buffer);
    this.refreshInFlight = { socket, generation, epoch, promise };
    try {
      await promise;
    } finally {
      if (this.refreshInFlight?.promise === promise) {
        this.refreshInFlight = null;
      }
      if (this.refreshBuffer === buffer) {
        this.refreshBuffer = null;
      }
    }
  }

  private async runWorldRefresh(
    socket: Socket,
    generation: number,
    epoch: number,
    buffer: RefreshBuffer,
  ): Promise<void> {
    const attempts = Math.max(1, (this.config.retryAttempts ?? 0) + 1);
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const raw = await this.requestWorldSnapshot(socket, generation, epoch);
        const parsed = WorldDataSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `World snapshot validation failed: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          );
        }
        const candidate = parsed.data as unknown as WorldData;
        if (candidate.userId !== this.socketUserId) {
          throw new Error('World snapshot identity does not match authenticated socket session');
        }
        if (!this.isCurrentSocket(socket, generation, epoch)) {
          throw new Error('World snapshot arrived for a retired socket session');
        }
        if (buffer.overflowed) {
          throw new Error('World snapshot event buffer overflowed during refresh');
        }
        for (const event of buffer.events) {
          if (event.kind === 'document') {
            applyDocumentBroadcast(candidate, event.value);
            if (documentBroadcastRequiresRefresh(candidate, event.value)) {
              throw new Error('World snapshot contains an unapplied document broadcast');
            }
          } else {
            applyUserActivity(candidate, event.value);
          }
        }
        if (!this.isCurrentSocket(socket, generation, epoch)) {
          throw new Error('World snapshot session changed before publication');
        }
        this.publishWorldData(candidate);
        logger.info('World data refreshed', {
          actors: candidate.actors.length,
          items: candidate.items.length,
          replayedEvents: buffer.events.length,
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          buffer.overflowed ||
          !this.isCurrentSocket(socket, generation, epoch) ||
          !socket.connected
        ) {
          break;
        }
        if (attempt < attempts && (this.config.retryDelay ?? 0) > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.config.retryDelay));
        }
      }
    }
    this.worldDataStale = this.worldData !== null;
    throw lastError ?? new Error('World snapshot refresh failed');
  }

  private requestWorldSnapshot(
    socket: Socket,
    generation: number,
    epoch: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        this.pendingWorldRequests.delete(cancel);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const cancel = (error: Error) => finish(error);
      const timeoutId = setTimeout(
        () => finish(new Error(`World snapshot ACK timed out after ${this.config.timeout}ms`)),
        this.config.timeout,
      );
      this.pendingWorldRequests.add(cancel);
      try {
        socket.emit('world', (value: unknown) => {
          if (!this.isCurrentSocket(socket, generation, epoch)) {
            finish(new Error('World snapshot ACK belongs to a retired socket session'));
            return;
          }
          finish(undefined, value);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  getWorldData(): WorldData | null {
    return this.isDelegatedMode() ? this.readWorld('search') : this.worldData;
  }

  // ==========================================================================
  // Actor methods
  // ==========================================================================

  private paginationContext(
    kind: string,
    filters: Record<string, unknown>,
    surface: ReadSurface,
  ): string {
    if (this.isDelegatedMode()) {
      const state = this.requireDelegatedState();
      return JSON.stringify({
        kind,
        filters,
        callerId: state.context.callerId,
        userId: state.context.userId,
        worldId: state.context.worldId,
        sessionId: state.context.sessionId,
        authorizationFingerprint: state.fingerprintFor(surface),
      });
    }
    const world = this.config.apiKey
      ? this.restStatusIdentity
      : JSON.stringify(this.worldData?.world ?? null);
    const caller = this.config.apiKey
      ? `${this.config.baseUrl}|${this.config.apiKey}`
      : `${this.worldData?.userId ?? 'unknown'}|${this.paginationSession}`;
    return JSON.stringify({ kind, filters, world, caller });
  }

  private assertSocketPaginationAuthorized(): void {
    if (this.isDelegatedMode()) {
      this.requireDelegatedState();
      return;
    }
    if (this.config.apiKey) {
      return;
    }
    if (!this.worldData) {
      throw new Error(WORLD_DATA_UNAVAILABLE_MESSAGE);
    }
    const caller = this.worldData.users.find((user) => user._id === this.worldData?.userId);
    if (!caller || typeof caller.role !== 'number' || caller.role < 4) {
      throw new Error('Socket pagination requires an authenticated GM with role 4 or higher');
    }
  }

  private validateSearchFilters(filters: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(filters)) {
      validateBoundedText(value, name, name === 'query' ? 1024 : 128);
    }
  }

  private paginationParams(params: {
    limit?: number | undefined;
    cursor?: string | undefined;
  }): PaginationParams {
    const result: PaginationParams = {};
    if (params.limit !== undefined) {
      result.limit = params.limit;
    }
    if (params.cursor !== undefined) {
      result.cursor = params.cursor;
    }
    return result;
  }

  private async fetchAllRestActors(filters: {
    query?: string | undefined;
    type?: string | undefined;
  }): Promise<FoundryActor[]> {
    const requestFilters = Object.fromEntries(
      Object.entries(filters).filter((entry) => entry[1] !== undefined),
    );
    const records: FoundryActor[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    let snapshotId: string | undefined;
    for (let page = 1; page <= 10_000; page += 1) {
      const response = await this.executeWithRetry(() =>
        this.http.get('/api/actors', {
          params: {
            ...requestFilters,
            page,
            limit: 100,
            ...(snapshotId === undefined ? {} : { snapshotId }),
          },
        }),
      );
      const result = restActorPageSchema.parse(response.data);
      if (page > 1 && result.snapshotId !== snapshotId) {
        throw new Error('REST actor pagination snapshot changed or was omitted');
      }
      if (result.page !== page) {
        throw new Error(`REST actor pagination ignored requested page ${page}`);
      }
      if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100) {
        throw new Error('REST actor pagination returned an invalid page limit');
      }
      if (result.actors.length > result.limit) {
        throw new Error('REST actor pagination returned more records than its page limit');
      }
      if (expectedTotal === undefined) {
        expectedTotal = result.total;
        if (!Number.isInteger(expectedTotal) || expectedTotal < 0 || expectedTotal > 10_000) {
          throw new Error('REST actor pagination returned an invalid or oversized total');
        }
      } else if (result.total !== expectedTotal) {
        throw new Error('REST actor pagination returned inconsistent totals');
      }
      for (const value of result.actors) {
        const actor = restActor(value);
        if (seen.has(actor._id)) {
          throw new Error(`REST actor pagination returned duplicate id ${actor._id}`);
        }
        seen.add(actor._id);
        records.push(actor);
      }
      if (records.length > expectedTotal) {
        throw new Error('REST actor pagination returned more records than its reported total');
      }
      if (records.length === expectedTotal) {
        return records;
      }
      if (result.actors.length === 0) {
        throw new Error('REST actor pagination made no progress before reaching its total');
      }
      if (result.snapshotId === undefined) {
        throw new Error('REST actor pagination requires a backend snapshotId for multiple pages');
      }
      snapshotId = result.snapshotId;
    }
    throw new Error('REST actor pagination exceeded the maximum supported page count');
  }

  private async restItemIdentity(): Promise<ItemEconomyIdentity> {
    try {
      const response = await this.executeWithRetry(() => this.http.get('/api/world'));
      return restItemSystemIdentity(response.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return { id: 'unknown' };
      }
      throw error;
    }
  }

  private async fetchAllRestItems(): Promise<FoundryItem[]> {
    const records: FoundryItem[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    let snapshotId: string | undefined;
    for (let page = 1; page <= 10_000; page += 1) {
      const response = await this.executeWithRetry(() =>
        this.http.get('/api/items', {
          params: { page, limit: 100, ...(snapshotId === undefined ? {} : { snapshotId }) },
        }),
      );
      const result = restItemPageSchema.parse(response.data);
      if (page > 1 && result.snapshotId !== snapshotId) {
        throw new Error('REST item pagination snapshot changed or was omitted');
      }
      if (result.page !== page) {
        throw new Error(`REST item pagination ignored requested page ${page}`);
      }
      if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100) {
        throw new Error('REST item pagination returned an invalid page limit');
      }
      if (result.items.length > result.limit) {
        throw new Error('REST item pagination returned more records than its page limit');
      }
      if (expectedTotal === undefined) {
        expectedTotal = result.total;
        if (!Number.isInteger(expectedTotal) || expectedTotal < 0 || expectedTotal > 10_000) {
          throw new Error('REST item pagination returned an invalid or oversized total');
        }
      } else if (result.total !== expectedTotal) {
        throw new Error('REST item pagination returned inconsistent totals');
      }
      for (const value of result.items) {
        const item = restItem(value);
        if (seen.has(item._id)) {
          throw new Error(`REST item pagination returned duplicate id ${item._id}`);
        }
        seen.add(item._id);
        records.push(item);
      }
      if (records.length > expectedTotal) {
        throw new Error('REST item pagination returned more records than its reported total');
      }
      if (records.length === expectedTotal) {
        return records;
      }
      if (result.items.length === 0) {
        throw new Error('REST item pagination made no progress before reaching its total');
      }
      if (result.snapshotId === undefined) {
        throw new Error('REST item pagination requires a backend snapshotId for multiple pages');
      }
      snapshotId = result.snapshotId;
    }
    throw new Error('REST item pagination exceeded the maximum supported page count');
  }

  async searchActors(params: SearchActorsParams): Promise<ActorSearchResult> {
    this.assertReadSurfaceAllowed('actors');
    const filters = { query: params.query, type: params.type };
    this.validateSearchFilters(filters);
    this.assertSocketPaginationAuthorized();
    const context = this.paginationContext('actor-search', filters, 'actors');
    let records: FoundryActor[] | undefined;
    if (params.cursor === undefined) {
      if (this.config.apiKey) {
        records = await this.fetchAllRestActors(filters);
      } else {
        const worldData = this.readWorld('actors');
        records = worldData.actors
          .filter(
            (actor) =>
              (!params.query || actor.name.toLowerCase().includes(params.query.toLowerCase())) &&
              (!params.type || actor.type.toLowerCase() === params.type.toLowerCase()),
          )
          .map(worldActorToFoundry);
      }
      records.sort(compareFoundryRecords);
    }
    const page = this.paginator.paginate(records, params, context, this.getReadMetadata());
    const { records: actors, ...metadata } = page;
    return { actors, ...metadata };
  }

  async getActor(actorId: string): Promise<FoundryActor> {
    this.assertReadSurfaceAllowed('actors');
    assertReadId(actorId, 'actorId');
    if (this.config.apiKey) {
      const response = await this.executeWithRetry(() => this.http.get(`/api/actors/${actorId}`));
      return restActor(restDetailDocument(response.data), actorId);
    }

    const actor = this.readWorld('actors').actors.find((a) => a._id === actorId);
    if (!actor) {
      throw new Error(`Actor not found: ${actorId}`);
    }

    return worldActorToFoundry(actor);
  }

  private actorReadWorld(
    actorId: unknown,
    unavailableMessage = 'Actor read unavailable',
  ): { world: WorldData; actor: WorldActor } {
    assertReadId(actorId, 'actorId');
    if (this.config.apiKey) {
      throw new Error('Structured actor-sheet reads are unsupported by the REST backend');
    }
    const world = this.readWorld('actors');
    const actor = world.actors.find((candidate) => candidate._id === actorId);
    if (!actor) {
      throw new Error(unavailableMessage);
    }
    const system = actorSystemIdentity(world);
    if (system.profile === 'generic' && this.isDelegatedMode()) {
      throw new Error(unavailableMessage);
    }
    return { world, actor };
  }

  getActorSheet(actorId: string): ActorSheetOutput {
    this.assertReadSurfaceAllowed('actors');
    const { world, actor } = this.actorReadWorld(actorId);
    const system = actorSystemIdentity(world);
    const delegated = this.isDelegatedMode();
    return {
      schemaVersion: 1,
      documentType: 'ActorSheet',
      actor: publicActorIdentity(actor),
      system,
      sections: ACTOR_SECTION_NAMES.map((name) => {
        const supported = isActorSectionSupported(system.profile, name, delegated);
        return {
          name,
          supported,
          fieldCount: supported
            ? actorSectionFields(actor, system.profile, name, delegated).length
            : 0,
        };
      }),
      itemCount: Array.isArray(actor.items) ? actor.items.length : 0,
      readMetadata: this.getAvailableReadMetadata(),
    };
  }

  getActorSection(actorId: string, section: ActorSectionName): ActorSectionOutput {
    this.assertReadSurfaceAllowed('actors');
    const { world, actor } = this.actorReadWorld(actorId);
    const system = actorSystemIdentity(world);
    const delegated = this.isDelegatedMode();
    const supported = isActorSectionSupported(system.profile, section, delegated);
    return {
      schemaVersion: 1,
      documentType: 'ActorSection',
      actor: publicActorIdentity(actor),
      system,
      section,
      supported,
      fields: supported ? actorSectionFields(actor, system.profile, section, delegated) : [],
      readMetadata: this.getAvailableReadMetadata(),
    };
  }

  listActorItems(params: ListActorItemsParams): ActorItemListOutput {
    this.assertReadSurfaceAllowed('actors');
    assertReadId(params.actorId, 'actorId');
    this.validateSearchFilters({ query: params.query, type: params.type });
    this.assertSocketPaginationAuthorized();
    const { world, actor } = this.actorReadWorld(params.actorId);
    const system = actorSystemIdentity(world);
    const delegated = this.isDelegatedMode();
    const items = Array.isArray(actor.items) ? actor.items : [];
    const visibleProjection = items.map((item) => ({
      summary: publicActorItemSummary(actor._id, item, system),
      fields: actorItemFields(item, system.profile, delegated),
      sort: typeof item.sort === 'number' ? item.sort : null,
    }));
    const contentFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          actor: publicActorIdentity(actor),
          items: visibleProjection,
        }),
      )
      .digest('hex');
    const filters = {
      actorId: actor._id,
      query: params.query,
      type: params.type,
      contentFingerprint,
    };
    const context = this.paginationContext('actor-item-list', filters, 'actors');
    let records: ActorItemSummary[] | undefined;
    if (params.cursor === undefined) {
      const query = params.query?.toLocaleLowerCase();
      const type = params.type?.toLocaleLowerCase();
      records = visibleProjection
        .map(({ summary }) => summary)
        .filter(
          (item) =>
            (!query || item.name.toLocaleLowerCase().includes(query)) &&
            (!type || item.type.toLocaleLowerCase() === type),
        )
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
            left.id.localeCompare(right.id),
        );
    }
    const page = this.paginator.paginate(
      records,
      this.paginationParams(params),
      context,
      this.getAvailableReadMetadata(),
    );
    if (page.readMetadata.freshness === 'unavailable') {
      throw new Error(WORLD_DATA_UNAVAILABLE_MESSAGE);
    }
    const readMetadata = availableWorldReadMetadataSchema.parse(page.readMetadata);
    return {
      schemaVersion: 2,
      documentType: 'ActorItemCollection',
      actor: publicActorIdentity(actor),
      ...page,
      readMetadata,
    };
  }

  getActorItem(actorId: string, itemId: string): ActorItemOutput {
    this.assertReadSurfaceAllowed('actors');
    assertReadId(actorId, 'actorId');
    assertReadId(itemId, 'itemId');
    const { world, actor } = this.actorReadWorld(actorId, 'Actor item read unavailable');
    const item = (Array.isArray(actor.items) ? actor.items : []).find(
      (candidate) => candidate._id === itemId,
    );
    if (!item) {
      throw new Error('Actor item read unavailable');
    }
    const system = actorSystemIdentity(world);
    const delegated = this.isDelegatedMode();
    return {
      schemaVersion: 2,
      documentType: 'ActorItem',
      actor: publicActorIdentity(actor),
      item: {
        ...publicActorItemSummary(actor._id, item, system),
        parentActorId: actor._id,
        fields: actorItemFields(item, system.profile, delegated),
        systemFieldsSupported: system.profile !== 'generic' || !delegated,
      },
      readMetadata: this.getAvailableReadMetadata(),
    };
  }

  /**
   * Returns the raw WorldActor with the full system data (game-system specific).
   */
  getRawActor(actorId: string): WorldActor | undefined {
    return this.readWorld('actors').actors.find((a) => a._id === actorId);
  }

  /**
   * Patches attributes on an actor's `system` object (#143). WRITE — Socket.IO.
   *
   * `patch` keys are dot-paths into `actor.system` (e.g. `attributes.hp.value`,
   * `currency.gp`, `spells.spell1.value`, `attributes.exhaustion`). Each key is
   * prefixed with `system.` and sent through the Socket.IO `modifyDocument`
   * write protocol as an `Actor` `update` — matching FoundryVTT's own document
   * model (`Actor#update`). No REST call and no `apiKey` are involved.
   *
   * Client-side validation, using the actor's current data, rejects:
   *  - HP value exceeding `max + temp`,
   *  - spell-slot value exceeding its `max`,
   *  - exhaustion outside `0–10` (2024 rules) or `0–6` (2014 rules).
   *
   * @throws via `assertWriteable()` if `writeEnabled` is false or the socket
   *   is not connected; also if the id is malformed, the actor/path is missing,
   *   or a validation rule is violated.
   */
  async updateActorAttribute(
    actorId: string,
    patch: AttributePatch,
  ): Promise<ActorAttributeUpdateResult> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!isRecord(patch) || Object.keys(patch).length === 0) {
      throw new Error('patch is required and must contain at least one attribute path');
    }

    // Fetch current actor data to validate paths and bounds. getActor returns
    // the mapped actor in socket mode (no `system`), so fall back to the cached
    // raw actor for the system document the validator needs.
    const actor = await this.getActor(actorId);
    const rawSystem = systemOf(actor) ?? systemOf(this.getRawActor(actorId));
    validateAttributePatch(patch, actor, rawSystem);

    // The patch keys are dot-paths into `actor.system`; prefix each with
    // `system.` for the document update. FoundryVTT accepts dot-notation keys
    // in update objects and merges recursively.
    const update: Record<string, unknown> = { _id: actorId };
    for (const [path, value] of Object.entries(patch)) {
      update[`system.${path}`] = value;
    }
    const result = await this.modifyDocument('Actor', 'update', {
      updates: [update],
      diff: true,
      recursive: true,
    });

    // Echo the post-update value for each patched path. Prefer the server's
    // returned document when present; otherwise reflect the requested value.
    const returned = isRecord(result[0]) ? (result[0] as Record<string, unknown>) : undefined;
    const updatedAttributes: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(patch)) {
      const fromServer = returned ? getDotPath(returned, `system.${path}`) : undefined;
      updatedAttributes[path] = fromServer !== undefined ? fromServer : value;
    }

    return { success: true, updatedAttributes };
  }

  // ==========================================================================
  // Item methods
  // ==========================================================================

  async searchItems(params: SearchItemsParams): Promise<ItemSearchResult> {
    this.assertReadSurfaceAllowed('items');
    const filters = { query: params.query, type: params.type, rarity: params.rarity };
    this.validateSearchFilters(filters);
    this.assertSocketPaginationAuthorized();
    const context = this.paginationContext('item-search', filters, 'items');
    let records: NormalizedFoundryItem[] | undefined;
    if (params.cursor === undefined) {
      let identity: ItemEconomyIdentity;
      if (this.config.apiKey) {
        const rawItems = await this.fetchAllRestItems();
        identity =
          rawItems.some((item) => item.system !== undefined) || params.rarity
            ? await this.restItemIdentity()
            : { id: 'unknown' };
        records = rawItems
          .filter(
            (item) =>
              (!params.query || item.name.toLowerCase().includes(params.query.toLowerCase())) &&
              (!params.type || item.type.toLowerCase() === params.type.toLowerCase()),
          )
          .map((item) => restItem(item, identity));
      } else {
        const worldData = this.readWorld('items');
        identity = actorSystemIdentity(worldData);
        records = worldData.items
          .filter(
            (item) =>
              (!params.query || item.name.toLowerCase().includes(params.query.toLowerCase())) &&
              (!params.type || item.type.toLowerCase() === params.type.toLowerCase()),
          )
          .map((item) => worldItemToFoundry(item, identity));
      }
      assertItemRarityFilter(identity, params.rarity);
      records = records.filter((item) => itemMatchesRarity(item.economy, params.rarity));
      records.sort(compareFoundryRecords);
    }
    const page = this.paginator.paginate(records, params, context, this.getReadMetadata());
    const { records: items, ...metadata } = page;
    return { items, ...metadata };
  }

  /** Read one world item only; actor-owned and compendium items are excluded. */
  async getItem(itemId: string): Promise<FoundryItem> {
    this.assertReadSurfaceAllowed('items');
    assertReadId(itemId, 'itemId');
    if (this.config.apiKey) {
      const response = await this.executeWithRetry(() => this.http.get(`/api/items/${itemId}`));
      const raw = restItemWireSchema.parse(restDetailDocument(response.data));
      const identity = raw.system !== undefined ? await this.restItemIdentity() : { id: 'unknown' };
      return restItem(raw, identity, itemId);
    }
    const world = this.readWorld('items');
    const item = world.items.find((entry) => entry._id === itemId);
    if (!item) {
      throw new Error(`Item not found: ${itemId}`);
    }
    return worldItemToFoundry(item, actorSystemIdentity(world));
  }

  // ==========================================================================
  // Compendium methods
  // ==========================================================================

  /** Actively verify compendium support and report other Foundry integrations honestly. */
  async getCapabilities(): Promise<CapabilityReport> {
    this.assertReadSurfaceAllowed('compendia');
    const compendium = await this.compendiumAdapter.probe();
    const verifiedAt = new Date().toISOString();
    if (compendium.status !== 'available') {
      this.compendiumPaginator.clear();
    }
    return {
      schemaVersion: 1,
      capabilities: [
        compendium,
        {
          ...RULES_LOOKUP_UNAVAILABLE,
          verifiedAt,
          transport: 'rest',
        },
        {
          ...DIAGNOSTICS_UNAVAILABLE,
          verifiedAt,
          transport: 'rest',
        },
        {
          ...CONTENT_GENERATION_UNAVAILABLE,
          verifiedAt,
          transport: 'rest',
        },
      ],
    };
  }

  private getCompendiumRelayIdentity(): string {
    const previous = this.compendiumRelayConfig;
    const { restUrl, restClientId, restApiKey } = this.config;
    if (
      !previous ||
      previous.restUrl !== restUrl ||
      previous.restClientId !== restClientId ||
      previous.restApiKey !== restApiKey
    ) {
      this.compendiumRelayConfig = { restUrl, restClientId, restApiKey };
      this.compendiumRelayIdentity = randomUUID();
      this.compendiumPaginator.clear();
    }
    return this.compendiumRelayIdentity;
  }

  /** Search the optional authenticated relay, preserving the core Socket.IO session. */
  async searchCompendium(input: CompendiumSearchParams): Promise<CompendiumSearchResult> {
    this.assertReadSurfaceAllowed('compendia');
    const params = compendiumParamsSchema.parse(input);
    const { limit, cursor, ...filters } = params;
    const response =
      cursor !== undefined
        ? { capability: await this.compendiumAdapter.probe(), entries: undefined }
        : await this.compendiumAdapter.search(params);
    const capability = response.capability;
    if (capability.status !== 'available') {
      this.compendiumPaginator.clear();
      return {
        schemaVersion: 1,
        capability: { ...capability, status: capability.status },
        restAvailable: false,
        results: null,
        total: null,
        page: null,
        limit: limit ?? 20,
        nextCursor: null,
      };
    }
    const context = {
      filters,
      session: this.paginationSession,
      world: this.snapshotWorldId ?? this.restWorldId,
      relayIdentity: this.getCompendiumRelayIdentity(),
    };
    const now = new Date().toISOString();
    const metadata: WorldReadMetadata = {
      source: 'rest',
      freshness: 'current',
      worldId: this.snapshotWorldId ?? this.restWorldId,
      sessionId: this.readSessionId,
      snapshotId: null,
      revision: 0,
      capturedAt: null,
      observedAt: now,
      respondedAt: now,
    };
    const entries = response.entries?.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.compendiumId.localeCompare(right.compendiumId) ||
        (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0),
    );
    const { records, ...page } = this.compendiumPaginator.paginate(
      entries,
      this.paginationParams(params),
      context,
      metadata,
      20,
    );
    return {
      schemaVersion: 1,
      capability: { ...capability, status: 'available' },
      restAvailable: true,
      results: records,
      ...page,
    };
  }

  // ==========================================================================
  // Write helpers (Socket.IO `modifyDocument` — primary transport, PRD-003)
  // ==========================================================================

  /**
   * Guards a write operation. Writes require the `FOUNDRY_WRITE_ENABLED` opt-in
   * and an active authenticated Socket.IO session (the primary transport).
   * Throws a clear, actionable error otherwise.
   */
  private assertWriteable(): void {
    if (this.isDelegatedMode()) {
      throw new CallerAuthorizationError();
    }
    if (!this.config.writeEnabled) {
      throw new Error(
        'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
      );
    }
    if (!this.socket?.connected) {
      throw new Error(
        'Write operations require an active Socket.IO connection to FoundryVTT (username/password mode).',
      );
    }
  }

  /**
   * Emits a Socket.IO event with an acknowledgement callback, resolving the
   * server's response and rejecting on timeout. Mirrors the ack pattern used by
   * the `world` event in {@link connectAndLoadWorld}/{@link refreshWorldData}.
   */
  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('Socket.IO is not connected'));
        return;
      }
      const timeoutMs = this.config.timeout || 10000;
      const timeout = setTimeout(
        () => reject(new Error(`Timeout waiting for '${event}' response (${timeoutMs}ms)`)),
        timeoutMs,
      );
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  /**
   * Performs a FoundryVTT document mutation over Socket.IO using the core
   * `modifyDocument` protocol. The request shape is verified against the
   * v13.348 client source (`client/data/client-backend.mjs` `#buildRequest`,
   * `helpers/socket-interface.mjs` `dispatch`, `common/abstract/socket.mjs`).
   *
   * @param type - Document name ("Actor", "Item", …)
   * @param action - "create" | "update" | "delete"
   * @param operation - action-specific payload: `data` (create) / `updates`
   *   (update) / `ids` (delete), plus `parentUuid` for embedded documents.
   * @returns the server's `result` array (created/updated data, or deleted ids)
   */
  private async modifyDocument(
    type: string,
    action: 'create' | 'update' | 'delete',
    operation: Record<string, unknown>,
  ): Promise<unknown[]> {
    const socket = this.socket;
    const generation = this.socketGeneration;
    const epoch = this.socketEpoch;
    const request = {
      type,
      action,
      operation: { broadcast: true, pack: null, modifiedTime: Date.now(), ...operation },
    };
    const response = await this.emitWithAck<DocumentSocketResponse>('modifyDocument', request);
    if (response?.error) {
      throw new Error(
        `FoundryVTT rejected ${action} ${type}: ${response.error.message || 'unknown error'}`,
      );
    }
    const result = Array.isArray(response?.result) ? response.result : [];
    if (socket && this.isCurrentSocket(socket, generation, epoch) && this.worldData) {
      const acknowledged = parseDocumentBroadcast({
        type,
        action,
        result,
        operation: request.operation,
      });
      if (acknowledged && applyDocumentBroadcast(this.worldData, acknowledged)) {
        this.noteSnapshotMutation();
      }
    }
    return result;
  }

  // ==========================================================================
  // Item mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Creates a new item on an actor via the `modifyDocument` socket protocol.
   *
   * Inline sources are created directly. Compendium sources are NOT yet
   * supported over Socket.IO — copying a pack entry needs a compendium read
   * that `modifyDocument` does not provide (tracked in issue #159).
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param source - inline item document (compendium source throws)
   * @returns the newly created item document
   */
  async createActorItem(actorId: string, source: ActorItemCreateSource): Promise<FoundryItem> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (source.type === 'compendium') {
      throw new Error(
        'Creating an item from a compendium source is not yet supported over Socket.IO; ' +
          'provide an inline item instead. See issue #159.',
      );
    }
    const result = await this.modifyDocument('Item', 'create', {
      data: [source.item],
      parentUuid: `Actor.${actorId}`,
    });
    return result[0] as FoundryItem;
  }

  /**
   * Applies a JSON merge patch to an item owned by an actor.
   *
   * The `patch` is merged into the item's `system` data (recursively, so nested
   * paths like the D&D 5e v4+ `activities.{id}.consumption.targets` are
   * preserved). Performed via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param itemId - 16-char alphanumeric item document id
   * @param patch - shallow/nested JSON merge patch applied to `item.system`
   * @returns the updated item document
   */
  async updateActorItem(
    actorId: string,
    itemId: string,
    patch: Record<string, unknown>,
  ): Promise<FoundryItem> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(itemId)) {
      throw new Error(`Invalid itemId format: ${itemId}`);
    }
    const result = await this.modifyDocument('Item', 'update', {
      updates: [{ _id: itemId, system: patch }],
      parentUuid: `Actor.${actorId}`,
      diff: true,
      recursive: true,
    });
    return result[0] as FoundryItem;
  }

  /**
   * Deletes an item owned by an actor via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param itemId - 16-char alphanumeric item document id
   */
  async deleteActorItem(actorId: string, itemId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(itemId)) {
      throw new Error(`Invalid itemId format: ${itemId}`);
    }
    await this.modifyDocument('Item', 'delete', {
      ids: [itemId],
      parentUuid: `Actor.${actorId}`,
    });
  }

  // ==========================================================================
  // Combat mutation methods (WRITE — Socket.IO modifyDocument, FR-018)
  // ==========================================================================

  /**
   * Updates the active combat's turn/round pointers (FR-018).
   *
   * `Combat` is a top-level document, so the update carries no `parentUuid`.
   * The patch fields map directly onto the Combat document (`turn`, `round`).
   *
   * @param combatId - 16-char alphanumeric Combat document id
   * @param patch - turn and/or round to set on the combat
   * @returns the updated combat document
   */
  async updateCombat(combatId: string, patch: { turn?: number; round?: number }): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    const result = await this.modifyDocument('Combat', 'update', {
      updates: [{ _id: combatId, ...patch }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Ends (deletes) the active combat encounter (FR-018).
   *
   * @param combatId - 16-char alphanumeric Combat document id
   */
  async endCombat(combatId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    await this.modifyDocument('Combat', 'delete', { ids: [combatId] });
  }

  /**
   * Sets a combatant's initiative (FR-018).
   *
   * `Combatant` is an embedded document inside `Combat`, so the update is sent
   * with `parentUuid: "Combat.<combatId>"`.
   *
   * @param combatId - 16-char alphanumeric Combat document id (the parent)
   * @param combatantId - 16-char alphanumeric Combatant document id
   * @param initiative - finite initiative value to assign
   * @returns the updated combatant document
   */
  async setCombatantInitiative(
    combatId: string,
    combatantId: string,
    initiative: number,
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(combatantId)) {
      throw new Error(`Invalid combatantId format: ${combatantId}`);
    }
    if (typeof initiative !== 'number' || !Number.isFinite(initiative)) {
      throw new Error(`Invalid initiative: ${initiative} (must be a finite number)`);
    }
    const result = await this.modifyDocument('Combatant', 'update', {
      updates: [{ _id: combatantId, initiative }],
      parentUuid: `Combat.${combatId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Starts a new combat encounter and seeds its combatants (FR-018, #172).
   *
   * Two-step `modifyDocument` flow:
   *   1. Create the top-level `Combat` document (no `parentUuid`), activated on
   *      the given scene, and read its `_id` from the response.
   *   2. Create the embedded `Combatant` documents with
   *      `parentUuid: "Combat.<combatId>"` (mirrors the Combatant→Combat embed
   *      used by {@link setCombatantInitiative}).
   *
   * The create wire shape is verified against the v13.348 client source per
   * `.claude/rules/foundry-write-protocol.md`; smoke-test one live round-trip
   * when changing it.
   *
   * @param sceneId - 16-char alphanumeric Scene document id the combat runs on
   * @param combatants - combatant seeds ({ tokenId, sceneId, actorId? })
   * @returns the new combat id and the number of combatants created
   */
  async startCombat(
    sceneId: string,
    combatants: Array<{ tokenId: string; sceneId: string; actorId?: string | undefined }>,
  ): Promise<{ combatId: string; combatantCount: number }> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    for (const c of combatants) {
      if (!FOUNDRY_ID_PATTERN.test(c.tokenId)) {
        throw new Error(`Invalid tokenId format: ${c.tokenId}`);
      }
    }

    const created = await this.modifyDocument('Combat', 'create', {
      data: [{ scene: sceneId, active: true }],
    });
    const combat = created[0] as { _id?: string } | undefined;
    const combatId = combat?._id;
    if (!combatId) {
      throw new Error('FoundryVTT did not return a Combat id after create');
    }

    if (combatants.length > 0) {
      await this.modifyDocument('Combatant', 'create', {
        data: combatants,
        parentUuid: `Combat.${combatId}`,
      });
    }

    return { combatId, combatantCount: combatants.length };
  }

  // ==========================================================================
  // Token mutation methods (WRITE — Socket.IO modifyDocument, FR-019)
  // ==========================================================================

  /**
   * Locates a token (and the scene it lives on) in the cached worldData.
   *
   * `Token` is an embedded document of `Scene`; worldData carries each scene's
   * tokens as raw records. When `sceneId` is omitted the search spans every
   * scene, so a token can be moved/affected without first resolving its scene.
   *
   * @param tokenId - 16-char alphanumeric Token document id
   * @param sceneId - optional Scene id to scope the search to
   * @returns the owning scene and the raw token record, or null if not found
   */
  findToken(
    tokenId: string,
    sceneId?: string,
  ): { scene: WorldScene; token: Record<string, unknown> } | null {
    this.assertReadSurfaceAllowed('tokens');
    if (!this.worldData) {
      return null;
    }
    const scenes = sceneId
      ? this.worldData.scenes.filter((s) => s._id === sceneId)
      : this.worldData.scenes;
    for (const scene of scenes) {
      const token = scene.tokens?.find((t) => (t as { _id?: string })._id === tokenId);
      if (token) {
        return { scene, token };
      }
    }
    return null;
  }

  /**
   * Moves a token to new x/y coordinates (FR-019).
   *
   * `Token` is an embedded document of `Scene`, so the update is sent with
   * `parentUuid: "Scene.<sceneId>"` (mirrors the Combatant→Combat embed). The
   * wire shape is verified against the v13.348 client source per
   * `.claude/rules/foundry-write-protocol.md`.
   *
   * @param sceneId - 16-char alphanumeric Scene document id (the parent)
   * @param tokenId - 16-char alphanumeric Token document id
   * @param x - target x pixel coordinate (finite number)
   * @param y - target y pixel coordinate (finite number)
   * @returns the updated token document
   */
  async moveToken(sceneId: string, tokenId: string, x: number, y: number): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — x and y must be finite numbers`);
    }
    const result = await this.modifyDocument('Token', 'update', {
      updates: [{ _id: tokenId, x, y }],
      parentUuid: `Scene.${sceneId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Creates a status-effect `ActiveEffect` on a token's actor (FR-019).
   *
   * `ActiveEffect` is an embedded document of `Actor`, so the create is sent with
   * the actor's parent UUID:
   *  - `Actor.<id>` for a world-linked actor (`actorLink: true`)
   *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` for an unlinked token's synthetic
   *    actor (the per-token delta).
   *
   * The effect carries a `statuses` array, matching how FoundryVTT v11+ models
   * conditions (`Actor#toggleStatusEffect` toggles by this field).
   *
   * @param parentActorUuid - the token actor's parent UUID (see forms above)
   * @param statusId - condition id (e.g. "prone", "stunned")
   * @param options - optional display `name` (defaults to `statusId`) and `img`
   * @returns the newly created ActiveEffect document
   */
  async createActorStatusEffect(
    parentActorUuid: string,
    statusId: string,
    options: { name?: string; img?: string } = {},
  ): Promise<WorldEffect> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!statusId || typeof statusId !== 'string') {
      throw new Error('statusId is required and must be a string');
    }
    const effectData: Record<string, unknown> = {
      name: options.name ?? statusId,
      statuses: [statusId],
    };
    if (options.img) {
      effectData.img = options.img;
    }
    const result = await this.modifyDocument('ActiveEffect', 'create', {
      data: [effectData],
      parentUuid: parentActorUuid,
    });
    return result[0] as WorldEffect;
  }

  /**
   * Deletes an `ActiveEffect` from a token's actor (FR-019), e.g. to clear a
   * status condition. Accepts the same parent-UUID forms as
   * {@link createActorStatusEffect}.
   *
   * @param parentActorUuid - the token actor's parent UUID
   * @param effectId - 16-char alphanumeric ActiveEffect document id
   */
  async deleteActorEffect(parentActorUuid: string, effectId: string): Promise<void> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(effectId)) {
      throw new Error(`Invalid effectId format: ${effectId}`);
    }
    await this.modifyDocument('ActiveEffect', 'delete', {
      ids: [effectId],
      parentUuid: parentActorUuid,
    });
  }

  // ==========================================================================
  // Scene methods
  // ==========================================================================

  private sceneSpatialProjection(): SceneSpatialProjection {
    this.assertReadSurfaceAllowed('scene-spatial');
    if (this.config.apiKey) {
      throw new Error('Structured scene spatial reads are unsupported by the REST backend');
    }
    if (this.isDelegatedMode()) {
      return this.requireDelegatedState().getSpatialView();
    }
    const source = this.requireWorldData();
    const callers = source.users.filter((candidate) => candidate._id === source.userId);
    const caller = callers.length === 1 ? callers[0] : undefined;
    if (
      !caller ||
      !Number.isInteger(caller.role) ||
      caller.role <= 0 ||
      caller.role > 4 ||
      typeof caller.name !== 'string' ||
      caller.name.length === 0 ||
      typeof caller.color !== 'string'
    ) {
      throw new Error('Scene spatial read unavailable');
    }
    return projectSceneSpatial(source, caller);
  }

  private selectSpatialScene(
    projection: SceneSpatialProjection,
    sceneId: string | undefined,
  ): SceneSpatialProjection['scenes'][number] {
    const selected = sceneId
      ? projection.scenes.find((entry) => entry.scene.id === sceneId)
      : projection.scenes.find((entry) => entry.scene.active);
    if (!selected) {
      throw new Error('Scene spatial read unavailable');
    }
    return selected;
  }

  private sceneIdentity(scene: SceneSpatialProjection['scenes'][number]['scene']): SceneIdentity {
    return { id: scene.id, uuid: scene.uuid, name: scene.name, active: scene.active };
  }

  getSceneSpatial(sceneId?: string): SceneSpatialOutput {
    if (sceneId !== undefined) {
      assertReadId(sceneId, 'sceneId');
    }
    const selected = this.selectSpatialScene(this.sceneSpatialProjection(), sceneId);
    return {
      schemaVersion: 1,
      documentType: 'Scene',
      scene: selected.scene,
      readMetadata: this.getAvailableReadMetadata(),
    };
  }

  listSceneTokens(params: ListSceneTokensParams): SceneTokenListOutput {
    if (params.sceneId !== undefined) {
      assertReadId(params.sceneId, 'sceneId');
    }
    validateBoundedText(params.query, 'query');
    const selected = this.selectSpatialScene(this.sceneSpatialProjection(), params.sceneId);
    const identity = this.sceneIdentity(selected.scene);
    const contentFingerprint = createHash('sha256')
      .update(JSON.stringify({ scene: selected.scene, tokens: selected.tokens }))
      .digest('hex');
    const context = this.paginationContext(
      'scene-token-list',
      {
        sceneSelector: params.sceneId === undefined ? 'active' : 'explicit',
        requestedSceneId: params.sceneId,
        resolvedSceneId: selected.scene.id,
        query: params.query,
        contentFingerprint,
      },
      'scene-spatial',
    );
    let records: SceneTokenSummary[] | undefined;
    if (params.cursor === undefined) {
      const query = params.query?.normalize('NFKC').toLowerCase();
      records = selected.tokens
        .filter((token) => !query || token.name.normalize('NFKC').toLowerCase().includes(query))
        .sort((left, right) => {
          const leftName = left.name.normalize('NFKC').toLowerCase();
          const rightName = right.name.normalize('NFKC').toLowerCase();
          return leftName < rightName
            ? -1
            : leftName > rightName
              ? 1
              : left.id.localeCompare(right.id);
        })
        .map(({ texture: _texture, ...summary }) => summary);
    }
    const page = this.sceneTokenPaginator.paginate(
      records,
      this.paginationParams(params),
      context,
      this.getAvailableReadMetadata(),
    );
    const readMetadata = availableWorldReadMetadataSchema.parse(page.readMetadata);
    return {
      schemaVersion: 1,
      documentType: 'Token',
      scene: identity,
      ...page,
      readMetadata,
    };
  }

  getSceneToken(sceneId: string | undefined, tokenId: string): SceneTokenOutput {
    if (sceneId !== undefined) {
      assertReadId(sceneId, 'sceneId');
    }
    assertReadId(tokenId, 'tokenId');
    const selected = this.selectSpatialScene(this.sceneSpatialProjection(), sceneId);
    const token = selected.tokens.find((candidate) => candidate.id === tokenId);
    if (!token) {
      throw new Error('Scene token read unavailable');
    }
    return {
      schemaVersion: 1,
      documentType: 'Token',
      scene: this.sceneIdentity(selected.scene),
      token,
      readMetadata: this.getAvailableReadMetadata(),
    };
  }

  async getCurrentScene(sceneId?: string): Promise<FoundryScene> {
    this.assertReadSurfaceAllowed('scenes');
    if (sceneId !== undefined && !FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const endpoint = sceneId ? `/api/scenes/${sceneId}` : '/api/scenes/current';
        const response = await this.http.get(endpoint);
        return response.data;
      });
    }

    if (!this.worldData) {
      throw new Error(WORLD_DATA_UNAVAILABLE_MESSAGE);
    }

    let scene: WorldScene | undefined;
    if (sceneId) {
      scene = this.worldData.scenes.find((s) => s._id === sceneId);
    } else {
      scene = this.worldData.scenes.find((s) => s.active);
    }

    if (!scene) {
      throw new Error(sceneId ? `Scene not found: ${sceneId}` : 'No active scene');
    }

    return worldSceneToFoundry(scene);
  }

  async getScene(sceneId: string): Promise<FoundryScene> {
    return this.getCurrentScene(sceneId);
  }

  getScenes(): WorldScene[] {
    this.assertReadSurfaceAllowed('scenes');
    return this.requireWorldData().scenes;
  }

  // ==========================================================================
  // World info
  // ==========================================================================

  async getWorldInfo(): Promise<FoundryWorld> {
    this.assertReadSurfaceAllowed('world-summary');
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/world');
        return response.data;
      });
    }

    const worldData = this.readWorld('world-summary');
    const metadata = this.getReadMetadata();
    const w = worldData.world as Record<string, unknown>;
    const s = worldData.system as Record<string, unknown>;
    const r = worldData.release as Record<string, unknown>;
    const created = normalizeTimestamp(w.created) ?? metadata.capturedAt;
    const modified = normalizeTimestamp(w.modified) ?? metadata.observedAt ?? metadata.capturedAt;
    if (!created || !modified) {
      throw new Error('World data unavailable — snapshot timestamps are missing');
    }

    return {
      id: (w.id as string) || 'unknown',
      title: (w.title as string) || 'Unknown World',
      description: (w.description as string) || '',
      system: (s.id as string) || 'unknown',
      coreVersion: (r.version as string) || (r.generation as string) || 'unknown',
      systemVersion: (s.version as string) || 'unknown',
      playtime: 0,
      created,
      modified,
    };
  }

  // ==========================================================================
  // Combat
  // ==========================================================================

  getCombatState(): WorldCombat | null {
    this.assertReadSurfaceAllowed('combat');
    return this.requireWorldData().combats.find((c) => c.active) ?? null;
  }

  // ==========================================================================
  // Chat messages
  // ==========================================================================

  getChatMessages(limit = 20): WorldMessage[] {
    const boundedLimit = parseChatLimit(limit);
    return this.readWorld('chat').messages.slice(-boundedLimit);
  }

  // ==========================================================================
  // Users
  // ==========================================================================

  getUsers(): { users: WorldUser[]; activeUsers: string[] } {
    const worldData = this.readWorld('users');
    return {
      users: worldData.users,
      activeUsers: worldData.activeUsers,
    };
  }

  // ==========================================================================
  // Journals
  // ==========================================================================

  getJournals(): WorldJournal[] {
    return this.readWorld('journals').journal;
  }

  searchJournals(query: string): WorldJournal[] {
    const worldData = this.readWorld('journals');
    const q = query.toLowerCase();
    return worldData.journal.filter((j) => {
      if (j.name.toLowerCase().includes(q)) {
        return true;
      }
      return j.pages?.some(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.text?.format === 2 ? p.text.markdown : p.text?.content)?.toLowerCase().includes(q),
      );
    });
  }

  async searchJournalsPage(params: SearchCollectionParams): Promise<CollectionPage> {
    validateBoundedText(params.query, 'query');
    if (this.config.apiKey) {
      throw new Error(
        'REST journal pagination is unsupported because no authenticated collection endpoint is available',
      );
    }
    this.assertSocketPaginationAuthorized();
    const filters = { query: params.query };
    const context = this.paginationContext('journal-search', filters, 'journals');
    let records: CollectionRecord[] | undefined;
    if (params.cursor === undefined) {
      records = sortCollectionRecords(
        this.searchJournals(params.query ?? '').map((journal) => ({
          id: journal._id,
          name: journal.name,
          documentType: 'JournalEntry' as const,
          pageCount: journal.pages?.length ?? 0,
        })),
      );
    }
    return this.paginator.paginate(
      records,
      this.paginationParams(params),
      context,
      this.getReadMetadata(),
    );
  }

  getJournal(journalId: string): WorldJournal | undefined {
    return this.readWorld('journals').journal.find((j) => j._id === journalId);
  }

  async getJournalSummaryPage(params: JournalSummaryPageParams): Promise<JournalSummaryPage> {
    const validated = journalSummaryPageParamsSchema.parse(params);
    assertJournalReadId(validated.journalId);
    if (this.config.apiKey) {
      throw new Error(
        'REST journal page reads are unsupported because no authenticated endpoint is available',
      );
    }
    this.assertSocketPaginationAuthorized();
    const journal = this.readWorld('journals').journal.find(
      (candidate) => candidate._id === validated.journalId,
    );
    if (!journal) {
      throw new JournalReadUnavailableError();
    }
    const prepared = prepareJournalRead(journal);
    const result = this.paginator.paginate(
      prepared.pages.map(journalPageSummary),
      this.paginationParams(validated),
      this.paginationContext(
        'journal-summary',
        {
          journalId: prepared.id,
          digest: prepared.digest,
        },
        'journals',
      ),
      this.getReadMetadata(),
      JOURNAL_DEFAULT_PAGE_LIMIT,
    );
    const { records: pages, ...pagination } = result;
    return {
      id: prepared.id,
      uuid: prepared.uuid,
      name: prepared.name,
      pages,
      ...pagination,
    };
  }

  async getJournalPageContent(params: JournalPageContentParams): Promise<JournalPageContent> {
    const validated = journalPageContentParamsSchema.parse(params);
    assertJournalReadId(validated.journalId);
    assertJournalReadId(validated.pageId);
    if (this.config.apiKey) {
      throw new Error(
        'REST journal page reads are unsupported because no authenticated endpoint is available',
      );
    }
    this.assertSocketPaginationAuthorized();
    const journal = this.readWorld('journals').journal.find(
      (candidate) => candidate._id === validated.journalId,
    );
    if (!journal) {
      throw new JournalReadUnavailableError();
    }
    const prepared = prepareJournalRead(journal);
    const page = prepared.pages.find((candidate) => candidate.metadata.id === validated.pageId);
    if (!page) {
      throw new JournalReadUnavailableError();
    }
    const format = validated.format ?? 'text';
    const content = journalContentChunks(page, format);
    const result = this.paginator.paginate(
      content.chunks,
      this.paginationParams(validated),
      this.paginationContext(
        'journal-page-content',
        {
          journalId: prepared.id,
          pageId: page.metadata.id,
          format,
          digest: prepared.digest,
        },
        'journals',
      ),
      this.getReadMetadata(),
      JOURNAL_DEFAULT_PAGE_LIMIT,
    );
    const { records: chunks, complete, page: paginationPage, ...pagination } = result;
    return {
      journalId: prepared.id,
      page: page.metadata,
      paginationPage,
      format,
      contentLength: content.contentLength,
      chunks,
      contentTruncated: !complete,
      complete,
      ...pagination,
    };
  }

  // ==========================================================================
  // Journal mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Creates a new JournalEntry with one or more text pages.
   *
   * `JournalEntry` is a top-level document (unlike Item/ActiveEffect, which
   * are embedded in an Actor), so the create carries no `parentUuid` —
   * mirrors {@link startCombat}'s top-level Combat create. Each entry in
   * `pages` is mapped to Foundry's native `JournalEntryPage` text-page shape,
   * with an explicit `sort` so the pages render in the order supplied.
   *
   * @param name - journal entry title
   * @param pages - one or more pages (name + content); at least one required
   * @param folder - optional 16-char Folder document id to file the entry under
   * @param visibility - who can see the entry (#204); omitted means GM-only,
   *   which is FoundryVTT's default for a newly created document
   * @returns the newly created journal entry document
   */
  async createJournalEntry(
    name: string,
    pages: JournalPageCreateSource[],
    folder?: string,
    visibility?: DocumentVisibility,
  ): Promise<WorldJournal> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('pages is required and must contain at least one page');
    }
    if (folder !== undefined && !FOUNDRY_ID_PATTERN.test(folder)) {
      throw new Error(`Invalid folder format: ${folder}`);
    }
    if (visibility !== undefined && !(visibility in VISIBILITY_LEVELS)) {
      throw new Error(
        `Invalid visibility: ${visibility}. Expected one of: ${Object.keys(VISIBILITY_LEVELS).join(', ')}`,
      );
    }

    const data: Record<string, unknown> = {
      name,
      pages: pages.map((p, i) => ({
        name: p.name,
        type: 'text',
        text: { content: p.content, format: 1 },
        sort: (i + 1) * SORT_INTEGER_DENSITY,
      })),
    };
    if (folder) {
      data.folder = folder;
    }
    if (visibility) {
      data.ownership = { default: VISIBILITY_LEVELS[visibility] };
    }

    const result = await this.modifyDocument('JournalEntry', 'create', {
      data: [data],
    });
    return result[0] as WorldJournal;
  }

  // ==========================================================================
  // Cross-collection search
  // ==========================================================================

  searchWorld(query: string): {
    actors: WorldActor[];
    items: WorldItem[];
    scenes: WorldScene[];
    journals: WorldJournal[];
  } {
    const worldData = this.readWorld('search');

    const q = query.toLowerCase();

    return {
      actors: worldData.actors.filter((a) => a.name.toLowerCase().includes(q)),
      items: worldData.items.filter((i) => i.name.toLowerCase().includes(q)),
      scenes: worldData.scenes.filter((s) => s.name.toLowerCase().includes(q)),
      journals: worldData.journal.filter((j) => j.name.toLowerCase().includes(q)),
    };
  }

  async searchWorldPage(params: SearchCollectionParams): Promise<CollectionPage> {
    validateBoundedText(params.query, 'query');
    if (this.config.apiKey) {
      throw new Error(
        'REST world pagination is unsupported because authenticated scene, journal, and user collection endpoints are unavailable',
      );
    }
    this.assertSocketPaginationAuthorized();
    const worldData = this.readWorld('search');
    const filters = { query: params.query };
    const context = this.paginationContext('world-search', filters, 'search');
    let records: CollectionRecord[] | undefined;
    if (params.cursor === undefined) {
      const query = (params.query ?? '').toLowerCase();
      records = sortCollectionRecords([
        ...worldData.actors
          .filter((record) => record.name.toLowerCase().includes(query))
          .map((record) => ({
            id: record._id,
            name: record.name,
            documentType: 'Actor' as const,
            type: record.type,
          })),
        ...worldData.items
          .filter((record) => record.name.toLowerCase().includes(query))
          .map((record) => ({
            id: record._id,
            name: record.name,
            documentType: 'Item' as const,
            type: record.type,
          })),
        ...worldData.scenes
          .filter((record) => record.name.toLowerCase().includes(query))
          .map((record) => ({
            id: record._id,
            name: record.name,
            documentType: 'Scene' as const,
            active: record.active,
          })),
        ...worldData.journal
          .filter((record) => record.name.toLowerCase().includes(query))
          .map((record) => ({
            id: record._id,
            name: record.name,
            documentType: 'JournalEntry' as const,
            pageCount: record.pages?.length ?? 0,
          })),
      ]);
    }
    return this.paginator.paginate(
      records,
      this.paginationParams(params),
      context,
      this.getReadMetadata(),
    );
  }

  async getCollectionPage(
    collection: 'actors' | 'items' | 'scenes' | 'journals' | 'users',
    params: PaginationParams,
  ): Promise<CollectionPage> {
    const surface: ReadSurface = collection === 'scenes' ? 'scenes' : collection;
    this.assertReadSurfaceAllowed(surface);
    this.assertSocketPaginationAuthorized();
    if (this.config.apiKey && !['actors', 'items'].includes(collection)) {
      throw new Error(
        `REST ${collection} pagination is unsupported because no authenticated collection endpoint is available`,
      );
    }

    const context = this.paginationContext('collection', { collection }, surface);
    let records: CollectionRecord[] | undefined;
    if (params.cursor === undefined) {
      if (this.config.apiKey) {
        if (collection === 'actors') {
          const actors = await this.fetchAllRestActors({});
          records = actors.map((record) => ({
            id: record._id,
            name: record.name,
            documentType: 'Actor',
            type: record.type,
          }));
        } else {
          const items = await this.fetchAllRestItems();
          records = items.map((record) => ({
            id: record._id,
            name: record.name,
            documentType: 'Item',
            type: record.type,
          }));
        }
      } else {
        const worldData = this.readWorld(surface);
        switch (collection) {
          case 'actors':
            records = worldData.actors.map((record) => ({
              id: record._id,
              name: record.name,
              documentType: 'Actor',
              type: record.type,
            }));
            break;
          case 'items':
            records = worldData.items.map((record) => ({
              id: record._id,
              name: record.name,
              documentType: 'Item',
              type: record.type,
            }));
            break;
          case 'scenes':
            records = worldData.scenes.map((record) => ({
              id: record._id,
              name: record.name,
              documentType: 'Scene',
              active: record.active,
            }));
            break;
          case 'journals':
            records = worldData.journal.map((record) => ({
              id: record._id,
              name: record.name,
              documentType: 'JournalEntry',
              pageCount: record.pages?.length ?? 0,
            }));
            break;
          case 'users':
            records = worldData.users.map((record) => ({
              id: record._id,
              name: record.name,
              documentType: 'User',
              active: worldData.activeUsers.includes(record._id),
              role: record.role,
            }));
            break;
        }
      }
      records = sortCollectionRecords(records);
    }
    return this.paginator.paginate(records, params, context, this.getReadMetadata());
  }

  // ==========================================================================
  // World summary
  // ==========================================================================

  getWorldSummary(): Record<string, number> {
    if (this.isDelegatedMode()) {
      return { ...this.requireDelegatedState().getSummary() };
    }
    const worldData = this.readWorld('world-summary');
    return {
      actors: worldData.actors.length,
      items: worldData.items.length,
      scenes: worldData.scenes.length,
      journals: worldData.journal.length,
      combats: worldData.combats.length,
      users: worldData.users.length,
      messages: worldData.messages.length,
      macros: worldData.macros.length,
      playlists: worldData.playlists.length,
      tables: worldData.tables.length,
      folders: worldData.folders.length,
    };
  }

  // ==========================================================================
  // Dice rolling
  // ==========================================================================

  /** Validates the whole bounded formula before choosing exactly one evaluator. */
  async rollDice(
    formula: string,
    reason?: string,
    engine: DiceRollInput['engine'] = 'auto',
  ): Promise<DiceRoll> {
    if (this.isDelegatedMode()) {
      throw new CallerAuthorizationError();
    }
    const input = parseDiceRollInput({
      formula,
      engine,
      ...(reason === undefined ? {} : { reason }),
    });
    let parsed: ReturnType<typeof parseDiceFormula>;
    try {
      parsed = parseDiceFormula(input.formula);
    } catch (error) {
      if (error instanceof InvalidDiceFormulaError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }

    const { restUrl, restApiKey, restClientId } = this.config;
    const configured = [restUrl, restApiKey, restClientId];
    const complete =
      typeof restUrl === 'string' &&
      restUrl.trim().length > 0 &&
      typeof restApiKey === 'string' &&
      restApiKey.trim().length > 0 &&
      typeof restClientId === 'string' &&
      restClientId.trim().length > 0;
    const partial = configured.some((value) => value !== undefined) && !complete;
    if (input.engine === 'foundry') {
      if (partial) {
        throw new Error(
          'Configure all FOUNDRY_REST_URL, FOUNDRY_REST_API_KEY, and FOUNDRY_REST_CLIENT_ID for dice.',
        );
      }
      if (!complete && this.config.apiKey !== undefined) {
        throw new Error(
          'Legacy dice REST transport is unsupported; configure FOUNDRY_REST_URL, FOUNDRY_REST_API_KEY, and FOUNDRY_REST_CLIENT_ID.',
        );
      }
      if (!complete && input.engine === 'foundry') {
        throw new Error('Foundry dice REST transport is not configured.');
      }
    }
    const native = input.engine === 'foundry' && complete;
    const result = native
      ? await new DiceRestAdapter({
          baseUrl: restUrl,
          apiKey: restApiKey,
          clientId: restClientId,
          userId: this.config.userId,
          timeout: this.config.timeout,
        }).roll(parsed, input.reason)
      : { ...evaluateParsedDiceFormula(parsed), timestamp: new Date().toISOString() };
    return diceRollOutputSchema.parse({
      schemaVersion: 1,
      engine: native ? 'foundry' : 'local',
      normalizedFormula: result.normalizedFormula,
      dice: result.dice.map((die, termIndex) => ({ ...die, termIndex })),
      total: result.total,
      breakdown: result.breakdown,
      timestamp: result.timestamp,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      fallback:
        input.engine === 'auto' && !native
          ? {
              requestedEngine: 'auto',
              reason: complete
                ? 'foundry-execution-not-requested'
                : 'foundry-transport-not-configured',
            }
          : null,
    });
  }

  // ==========================================================================
  // Connection test
  // ==========================================================================

  async testConnection(): Promise<boolean> {
    this.assertReadSurfaceAllowed('diagnostics');
    try {
      const user = this.config.userId || this.config.username;
      if (this.config.apiKey || (user && this.config.password !== undefined)) {
        await this.connect();
        return true;
      }

      const response = await this.http.get('/');
      logger.debug('Connection test successful', { status: response.status });
      return true;
    } catch (error) {
      logger.error('Failed to connect to FoundryVTT:', error);
      throw error;
    }
  }

  // ==========================================================================
  // HTTP helpers (preserved for REST API mode and diagnostics)
  // ==========================================================================

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    const maxAttempts = (this.config.retryAttempts || 3) + 1;
    const baseDelay = this.config.retryDelay || 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status && status >= 400 && status < 500 && status !== 429) {
            throw lastError;
          }
        }

        if (attempt === maxAttempts) {
          throw lastError;
        }

        const exponentialDelay = baseDelay * 2 ** (attempt - 1);
        const jitter = Math.random() * 0.1 * exponentialDelay;
        await new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
      }
    }

    throw lastError || new Error('Request failed after all retry attempts');
  }

  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    this.assertReadSurfaceAllowed('diagnostics');
    return this.executeWithRetry(() => this.http.get(url, config));
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    this.assertWriteable();
    return this.executeWithRetry(() => this.http.post(url, data, config));
  }

  async put<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    this.assertWriteable();
    return this.executeWithRetry(() => this.http.put(url, data, config));
  }

  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    this.assertWriteable();
    return this.executeWithRetry(() => this.http.delete(url, config));
  }
}

// ============================================================================
// Mapping helpers — WorldData raw documents → display interfaces
// ============================================================================

function compareFoundryRecords(
  left: Pick<FoundryActor | FoundryItem, '_id' | 'name'>,
  right: Pick<FoundryActor | FoundryItem, '_id' | 'name'>,
): number {
  const leftName = left.name.normalize('NFKC').toLowerCase();
  const rightName = right.name.normalize('NFKC').toLowerCase();
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  const leftId = left._id;
  const rightId = right._id;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function worldActorToFoundry(a: WorldActor): FoundryActor {
  worldReadDocumentSchema.parse(a);
  const sys = a.system;
  const hpRaw = extractNested(sys, 'attributes', 'hp');
  const hp = isRecord(hpRaw) ? hpRaw : undefined;
  const acRaw = extractNested(sys, 'attributes', 'ac');
  const ac = isRecord(acRaw) ? acRaw : undefined;
  const details = isRecord(sys.details) ? sys.details : {};

  const abilitiesRaw = sys.abilities;
  let mappedAbilities: FoundryActor['abilities'];
  if (isRecord(abilitiesRaw)) {
    mappedAbilities = {};
    for (const [key, val] of Object.entries(abilitiesRaw)) {
      if (isRecord(val)) {
        const entry: { value?: number; mod?: number; save?: number } = {};
        if (typeof val.value === 'number') {
          entry.value = val.value;
        }
        if (typeof val.mod === 'number') {
          entry.mod = val.mod;
        }
        if (typeof val.save === 'number') {
          entry.save = val.save;
        }
        mappedAbilities[key] = entry;
      }
    }
  }

  const actor: FoundryActor = {
    _id: a._id,
    uuid: `Actor.${a._id}`,
    name: a.name,
    type: a.type,
  };

  if (a.img !== undefined) {
    actor.img = a.img;
  }

  if (hp) {
    const hpObj: { value?: number; max?: number; temp?: number } = {};
    if (typeof hp.value === 'number') {
      hpObj.value = hp.value;
    }
    if (typeof hp.max === 'number') {
      hpObj.max = hp.max;
    }
    if (typeof hp.temp === 'number') {
      hpObj.temp = hp.temp;
    }
    actor.hp = hpObj;
  }

  if (ac && typeof ac.value === 'number') {
    actor.ac = { value: ac.value };
  }

  if (typeof details.level === 'number') {
    actor.level = details.level;
  }

  if (mappedAbilities) {
    actor.abilities = mappedAbilities;
  }

  const bio = extractString(details, 'biography', 'value') ?? extractString(details, 'biography');
  if (bio !== null) {
    actor.biography = bio;
  }

  actorDocumentSchema.parse(actor);
  return actor;
}

function worldItemToFoundry(i: WorldItem, identity: ItemEconomyIdentity): NormalizedFoundryItem {
  worldReadDocumentSchema.parse(i);
  const economy = normalizeItemEconomy(i, identity);
  const item: NormalizedFoundryItem = {
    _id: i._id,
    uuid: `Item.${i._id}`,
    name: i.name,
    type: i.type,
    economy,
    ...itemEconomyAliases(economy),
  };
  if (i.img !== undefined) {
    item.img = i.img;
  }
  const desc = extractString(i.system, 'description', 'value');
  if (desc !== null) {
    item.description = desc;
  }
  for (const key of ['weight', 'quantity'] as const) {
    const value =
      key === 'weight'
        ? (extractNested(i.system, 'weight', 'value') ?? i.system.weight)
        : i.system[key];
    if (typeof value === 'number') {
      item[key] = value;
    }
  }
  for (const key of ['equipped', 'identified'] as const) {
    const value = i.system[key];
    if (typeof value === 'boolean') {
      item[key] = value;
    }
  }
  itemDocumentSchema.parse(item);
  return item;
}

function worldSceneToFoundry(s: WorldScene): FoundryScene {
  const scene: FoundryScene = {
    _id: s._id,
    name: s.name,
    active: s.active,
    navigation: s.navigation,
    width: s.width,
    height: s.height,
    padding: s.padding,
    shiftX: 0,
    shiftY: 0,
    globalLight: s.globalLight,
    darkness: s.darkness,
  };
  if (s.img) {
    scene.img = s.img;
  }
  const desc = (s.flags as Record<string, unknown>)?.description;
  if (typeof desc === 'string') {
    scene.description = desc;
  }
  return scene;
}

/**
 * Safely extracts a nested value from a Record tree.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns the `system` object of an actor-like document, accepting either the
 * raw REST/world document (`{ ..., system }`) or a cached {@link WorldActor}.
 * Returns undefined when no system object is present (e.g. the mapped
 * {@link FoundryActor} produced by the socket world-cache path).
 */
function systemOf(obj: unknown): Record<string, unknown> | undefined {
  if (isRecord(obj) && isRecord(obj.system)) {
    return obj.system;
  }
  return undefined;
}

function extractNested(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (isRecord(current) && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Extracts a string from nested Record, following a chain of keys.
 */
function extractString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const val = extractNested(obj, ...keys);
  return typeof val === 'string' ? val : null;
}

// ============================================================================
// Attribute-patch helpers (#143)
// ============================================================================

/**
 * Reads a dot-path out of a nested Record tree, returning undefined if any
 * segment is missing.
 */
function getDotPath(obj: Record<string, unknown>, path: string): unknown {
  return extractNested(obj, ...path.split('.'));
}

/**
 * Reads the actor's game-system id from raw world data, when available.
 * Used to pick the exhaustion clamp (2024 dnd5e: 0–10; 2014: 0–6).
 */
function exhaustionMax(sys: Record<string, unknown> | undefined): number {
  // dnd5e 2024 rules cap exhaustion at 10; the 2014 rules cap it at 6.
  // Without an explicit rules-version signal, default to the wider 2024 range
  // so legitimate 2024 values are not rejected; the 2014 cap is applied when
  // the actor's system data exposes a `rules: "2014"`-style marker.
  if (isRecord(sys)) {
    const source = isRecord(sys._source) ? sys._source : undefined;
    const rules =
      extractString(sys, 'rules') ||
      (source ? extractString(source, 'rules') : null) ||
      extractString(sys, 'attributes', 'exhaustion', 'rules');
    if (rules === '2014' || rules === 'legacy') {
      return 6;
    }
  }
  return 10;
}

/**
 * Validates an attribute patch against the actor's current data, throwing a
 * clear error on the first violation. Only checks rules for which the needed
 * limit (max HP, slot max, exhaustion bound) is available.
 */
function validateAttributePatch(
  patch: AttributePatch,
  actor: FoundryActor,
  rawSystem: Record<string, unknown> | undefined,
): void {
  // Prefer the raw `system` document for bounds: in REST mode getActor returns
  // the raw document (HP at system.attributes.hp.{value,max,temp}); the mapped
  // FoundryActor.hp is only populated on the socket world-cache path.
  const rawHp = rawSystem ? extractNested(rawSystem, 'attributes', 'hp') : undefined;
  const hp = isRecord(rawHp) ? rawHp : undefined;

  for (const [path, value] of Object.entries(patch)) {
    // HP value cannot exceed max + temp.
    if (path === 'attributes.hp.value' && typeof value === 'number') {
      const patchedTemp = patch['attributes.hp.temp'];
      const currentTemp = typeof hp?.temp === 'number' ? hp.temp : (actor.hp?.temp ?? 0);
      const temp = typeof patchedTemp === 'number' ? patchedTemp : currentTemp;
      const max = typeof hp?.max === 'number' ? hp.max : actor.hp?.max;
      if (typeof max === 'number' && value > max + temp) {
        throw new Error(
          `Invalid HP value ${value}: exceeds max + temp (${max} + ${temp} = ${max + temp})`,
        );
      }
    }

    // Spell-slot value cannot exceed its max.
    const slotMatch = /^spells\.(spell\w+|pact)\.value$/.exec(path);
    const slotKey = slotMatch?.[1];
    if (slotKey && typeof value === 'number' && rawSystem) {
      const slotMax = extractNested(rawSystem, 'spells', slotKey, 'max');
      if (typeof slotMax === 'number' && value > slotMax) {
        throw new Error(
          `Invalid spell slot value ${value} for ${slotKey}: exceeds max (${slotMax})`,
        );
      }
    }

    // Exhaustion clamped 0–10 (2024) or 0–6 (2014).
    if (path === 'attributes.exhaustion' && typeof value === 'number') {
      const max = exhaustionMax(rawSystem);
      if (value < 0 || value > max) {
        throw new Error(`Invalid exhaustion ${value}: must be between 0 and ${max}`);
      }
    }
  }
}

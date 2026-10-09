/**
 * @fileoverview Tool definitions for FoundryVTT MCP Server
 *
 * This module contains all tool schema definitions organized by category.
 * Tools are separated into logical groups for better maintainability.
 */

import {
  actorItemInputJsonSchema,
  actorItemListInputJsonSchema,
  actorItemListOutputJsonSchema,
  actorItemOutputJsonSchema,
  actorSectionInputJsonSchema,
  actorSectionOutputJsonSchema,
  actorSheetInputJsonSchema,
  actorSheetOutputJsonSchema,
} from '../foundry/actor-sheet-contract.js';
import {
  capabilitiesInputJsonSchema,
  capabilitiesOutputSchema,
  compendiumSearchInputJsonSchema,
  compendiumSearchOutputSchema,
} from '../foundry/compendium-contract.js';
import {
  errorDiagnosisInputJsonSchema,
  errorDiagnosisOutputJsonSchema,
} from '../foundry/diagnosis-contract.js';
import {
  lootGenerationInputJsonSchema,
  lootGenerationOutputJsonSchema,
  npcGenerationInputJsonSchema,
  npcGenerationOutputJsonSchema,
} from '../foundry/generation-contract.js';
import {
  journalPageInputJsonSchema,
  journalPageOutputSchema,
  journalSummaryInputJsonSchema,
  journalSummaryOutputSchema,
} from '../foundry/journal-contract.js';
import {
  actorDetailsOutputSchema,
  actorSearchInputJsonSchema,
  actorSearchOutputSchema,
  collectionSearchOutputSchema,
  itemDetailsOutputSchema,
  itemSearchInputJsonSchema,
  itemSearchOutputSchema,
  worldSearchInputJsonSchema,
} from '../foundry/read-contract.js';
import { ruleLookupInputJsonSchema, ruleLookupOutputJsonSchema } from '../foundry/rule-contract.js';
import {
  sceneSpatialInputJsonSchema,
  sceneSpatialOutputJsonSchema,
  sceneTokenInputJsonSchema,
  sceneTokenListInputJsonSchema,
  sceneTokenListOutputJsonSchema,
  sceneTokenOutputJsonSchema,
} from '../foundry/scene-spatial-contract.js';
import { delegatedTools } from './authorization.js';

/**
 * Shared write-safety clause appended to every mutation tool description.
 *
 * Both halves are enforced in code by `assertWriteable()`
 * (`src/foundry/client.ts`): the `FOUNDRY_WRITE_ENABLED` opt-in (default
 * `false`, see `src/config/index.ts`) and a live authenticated Socket.IO
 * session. Foundry itself enforces the GM/owner permission (ADR-010).
 */
const WRITE_GATE =
  'WRITE: mutates the live world. Requires FOUNDRY_WRITE_ENABLED=true (default false) and an active Socket.IO connection, and is refused otherwise; Foundry additionally enforces GM/owner permission on the document.';

/**
 * Extra clause for destructive tools (data removal that this server cannot undo).
 */
const CONFIRM_FIRST =
  'DESTRUCTIVE and not undoable from this server: confirm the exact target with the user before calling.';

/**
 * Canonical `roll_dice` description.
 *
 * Exported so `RollDiceTool` (`src/tools/handlers/dice.ts`) can reuse the exact
 * same string instead of keeping a second copy that silently drifts: the
 * registry class is what *executes* the tool while `getAllTools()` is what is
 * *listed*, so a divergence would be invisible.
 */
export const ROLL_DICE_DESCRIPTION =
  'Roll dice and return the total with a per-term breakdown. Dice terms and whole numbers joined by + or -, with whitespace allowed anywhere ("1d20+5", "1d20 + 5", "1d20+5+3", "2d6 + 1d4", "3d6"; a count-less "d20" means one die), always work and every term counts towards the total - that is the portable grammar, safe on either transport. Multiplication and Foundry modifier syntax such as "4d6kh3" or "1d20r1" are rejected on both transports, with an error naming the offending character and its position, never dropped from the total in silence. Parentheses are the one difference: with FOUNDRY_API_KEY set the formula goes to FoundryVTT\'s own Roll engine, which evaluates them, while the default Socket.IO transport rolls locally and rejects them by name - and a REST roll that cannot reach the server falls back to that same local roller, so a parenthesised formula can still fail there. Prefer the expanded form when it matters. Use when: the user asks for a check, save, attack, damage, or any random result.';

/**
 * Dice rolling tool definitions
 */
export const diceTools = [
  {
    name: 'roll_dice',
    description: ROLL_DICE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        formula: {
          type: 'string',
          description: 'Dice formula (e.g., "1d20+5", "3d6")',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the roll',
        },
      },
      required: ['formula'],
    },
  },
];

/**
 * Actor management tool definitions
 */
export const actorTools = [
  {
    name: 'search_actors',
    outputSchema: actorSearchOutputSchema,
    description:
      'Search world actors by name and type. Returns version 3 structuredContent with stable IDs, mapped stats, bounded snapshot pagination and readMetadata freshness/source timestamps. Follow nextCursor with the same query/type/limit until complete. Default limit 10; maximum 100. Snapshots expire after five minutes; start a new search after expiry. Socket reads require a GM; REST uses the authenticated backend view. Pass an ID to get_actor_details. Missing stats are omitted; zero is preserved.',
    inputSchema: actorSearchInputJsonSchema,
  },
  {
    name: 'get_actor_details',
    outputSchema: actorDetailsOutputSchema,
    description:
      'Read one world actor by its 16-character alphanumeric actorId from search_actors. Returns version 2 structuredContent and text with ID, type and available level, HP, AC, ability scores and biography. Invalid IDs fail with InvalidParams before lookup; missing, removed, unavailable or malformed records fail with InternalError. Returned identity is verified; readMetadata labels current or retained stale data with source timestamps. Use for a read-before-write step; actor-owned items and full sheets are outside this read.',
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'World actor ID from search_actors (not a UUID)',
          pattern: '^[a-zA-Z0-9]{16}$',
        },
      },
      required: ['actorId'],
    },
  },
  {
    name: 'get_actor_sheet',
    outputSchema: actorSheetOutputJsonSchema,
    description:
      'Read a bounded version 1 actor-sheet index for a 16-character actorId. Returns public actor and system identity, supported section names with field counts, owned-item count and read metadata. Follow with get_actor_section or list_actor_items. The REST backend rejects this read when it cannot prove field permissions.',
    inputSchema: actorSheetInputJsonSchema,
  },
  {
    name: 'get_actor_section',
    outputSchema: actorSectionOutputJsonSchema,
    description:
      'Read one bounded version 1 actor-sheet section. Normalized profile fields use stable keys; conservative fallback fields are labeled system-path. Missing fields remain present=false and numeric zero values remain zero. Supported sections are attributes, abilities, skills, details, currency, resources and system.',
    inputSchema: actorSectionInputJsonSchema,
  },
  {
    name: 'list_actor_items',
    outputSchema: actorItemListOutputJsonSchema,
    description:
      'List permission-projected items embedded in one actor with bounded snapshot pagination. Sorts by name then item ID, preserves duplicate names, and returns parent-bound Actor.<actorId>.Item.<itemId> UUIDs. Follow nextCursor with the same actorId, query, type and limit. Any visible inventory or permission change invalidates the cursor.',
    inputSchema: actorItemListInputJsonSchema,
  },
  {
    name: 'get_actor_item',
    outputSchema: actorItemOutputJsonSchema,
    description:
      'Read one permission-projected item embedded in the specified actor. Both IDs must be 16 alphanumeric characters. The item is resolved only within its parent actor and returns bounded normalized or system-path primitive fields; missing, denied, deleted and wrong-parent targets share an unavailable error.',
    inputSchema: actorItemInputJsonSchema,
  },
];

/**
 * Actor attribute mutation tool definitions (#143)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export const actorMutationTools = [
  {
    name: 'update_actor_attributes',
    description:
      'Update fields on an actor\'s system data. Patch keys are dot-paths into actor.system (e.g. "attributes.hp.value", "attributes.hp.temp", "currency.gp", "resources.primary.value", "spells.spell1.value", "attributes.exhaustion") and values are absolute target values, never relative deltas. Validates HP <= max + temp, spell slots <= max, and exhaustion within 0-10 (2024) or 0-6 (2014), and returns the post-update value for every patched path. Use when: applying damage or healing, spending a spell slot or resource, or adjusting currency on a known actorId. Do not use when: changing an item the actor owns (use update_actor_item) or only reading current values (use get_actor_details). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to update',
        },
        patch: {
          type: 'object',
          description:
            'Map of dot-path → value, where each dot-path addresses a field under actor.system ' +
            '(e.g. {"attributes.hp.value": 30, "currency.gp": 12}). Values must be number, string, or boolean.',
          additionalProperties: {
            type: ['number', 'string', 'boolean'],
          },
        },
      },
      required: ['actorId', 'patch'],
    },
  },
];

/**
 * Item management tool definitions
 */
export const itemTools = [
  {
    name: 'search_items',
    outputSchema: itemSearchOutputSchema,
    description:
      'Search world items by name, type and rarity. Returns version 3 structuredContent with stable IDs, mapped fields, bounded snapshot pagination and readMetadata freshness/source timestamps. Follow nextCursor with the same filters/limit until complete. Default limit 10; maximum 100; snapshots expire after five minutes. Socket reads require a GM; REST uses the authenticated backend view. Pass an ID to get_item_details. Excludes embedded and compendium items; zero and false are preserved.',
    inputSchema: itemSearchInputJsonSchema,
  },
  {
    name: 'get_item_details',
    outputSchema: itemDetailsOutputSchema,
    description:
      'Read one world item by its 16-character alphanumeric itemId from search_items using the same backend/cache view. Returns version 2 structuredContent and text with identity and available description, rarity, price, weight, quantity, equipped and identified values. Excludes actor-owned and compendium items. Invalid IDs fail with InvalidParams before lookup; missing, removed, unavailable or malformed records fail with InternalError. Returned identity is verified; readMetadata labels current or retained stale data with source timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          pattern: '^[a-zA-Z0-9]{16}$',
          description: 'World item ID from search_items (not a UUID or owned-item ID)',
        },
      },
      required: ['itemId'],
    },
  },
];

/**
 * Compendium search tool definitions (#144)
 */
export const compendiumTools = [
  {
    name: 'search_compendium',
    description:
      'Search compendium names and metadata through an optional authenticated Foundry REST relay. Returns verified capability status; unavailable results are null, while a verified zero-match search returns an empty array. Filters and cursors bind to an immutable snapshot. Requires FOUNDRY_REST_URL, FOUNDRY_REST_CLIENT_ID, and FOUNDRY_REST_API_KEY alongside the core Foundry connection.',
    inputSchema: compendiumSearchInputJsonSchema,
    outputSchema: compendiumSearchOutputSchema,
  },
  {
    name: 'get_capabilities',
    description:
      'Actively verify optional Foundry integrations and return versioned, redacted status and remediation. Reports Foundry-backed rules, diagnostics, and content generation as unavailable until implemented and verified.',
    inputSchema: capabilitiesInputJsonSchema,
    outputSchema: capabilitiesOutputSchema,
  },
];

/**
 * Actor item mutation tool definitions (WRITE — require FOUNDRY_WRITE_ENABLED
 * and an active Socket.IO connection; mutations use `modifyDocument`)
 *
 * The canonical mutation target is the D&D 5e v4+ activity schema. Item
 * `system` patches honour JSON-merge-patch semantics on nested paths.
 */
export const itemMutationTools = [
  {
    name: 'create_actor_item',
    description:
      'Create an item on an actor from an inline item document (type, name, system). Use when: adding a new weapon, spell, feature, or piece of equipment to a known actorId. Do not use when: editing an item the actor already owns - use update_actor_item. Replacing an item is not atomic: create the replacement first and delete the old one second, so a mid-sequence failure leaves the actor with a duplicate rather than nothing. Compendium-source create is not yet supported over Socket.IO (see issue #159). Canonical target: D&D 5e v4+ activity schema. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to add the item to',
        },
        source: {
          type: 'object',
          description:
            'Item source. Use { type: "inline", item: { type, name, system } } to create the item directly. The { type: "compendium", compendiumId, itemId } shape is accepted by the schema but rejected at call time - compendium-source create is not yet supported over Socket.IO.',
          properties: {
            type: {
              type: 'string',
              enum: ['compendium', 'inline'],
              description:
                'Source kind. Only "inline" is functional today; "compendium" is rejected at call time.',
            },
            compendiumId: {
              type: 'string',
              description: 'Compendium pack id (compendium source)',
            },
            itemId: {
              type: 'string',
              description: 'Item id within the compendium pack (compendium source)',
            },
            item: {
              type: 'object',
              description: 'Inline item document with type, name, and system (inline source)',
            },
          },
          required: ['type'],
        },
      },
      required: ['actorId', 'source'],
    },
  },
  {
    name: 'update_actor_item',
    description:
      "Apply a JSON merge patch to an item's system data on an actor: nested paths such as activities.{id}.consumption.targets are supported, values are absolute (arrays replace, null deletes). Use when: changing fields on an item the actor already owns, given actorId + itemId. Do not use when: adding a new item (create_actor_item) or removing one (delete_actor_item). Canonical target: D&D 5e v4+ activity schema. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor that owns the item',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to update',
        },
        patch: {
          type: 'object',
          description:
            'JSON merge patch applied to item.system; nested paths supported (e.g. activities.{id}.consumption.targets)',
        },
      },
      required: ['actorId', 'itemId', 'patch'],
    },
  },
  {
    name: 'delete_actor_item',
    description:
      "Permanently remove an item owned by an actor. Use when: the user explicitly asks to delete or discard a specific owned item, and has given you the itemId - no tool in this server lists owned-item ids, so never guess one. Do not use when: only the item's data needs to change - use update_actor_item. In a replacement or migration flow, run create_actor_item first and this second: the two calls are not atomic, and failing after the delete loses the item. Echo the actorId and itemId back to the user and get their confirmation before calling. " +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor that owns the item',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to delete',
        },
      },
      required: ['actorId', 'itemId'],
    },
  },
];

/**
 * Scene management tool definitions
 */
export const sceneTools = [
  {
    name: 'get_scene_info',
    description:
      "Get details of the active scene, or of a specific scene by id: name, scene id, active/navigation flags, pixel dimensions, padding and lighting (global light, darkness); no description text is returned unless a module has set a description flag on the scene (the description line otherwise reads 'No description available.'). Use when: you need the sceneId or the scene's pixel extents. Do not use when: looking a scene up by name (use search_world), or you need grid size or token coordinates - this tool returns neither.",
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional scene ID. If not provided, returns current scene',
        },
      },
    },
  },
  {
    name: 'get_scene_spatial',
    description:
      'Return bounded, versioned spatial metadata for an observable scene, including native canvas dimensions and origin, grid orientation and size, source pixel dimensions, padding, shifts, and explicit units. Omitting sceneId selects the currently active observable scene.',
    inputSchema: sceneSpatialInputJsonSchema,
    outputSchema: sceneSpatialOutputJsonSchema,
  },
  {
    name: 'list_scene_tokens',
    description:
      'List observable token summaries for an observable scene with stable snapshot pagination. Coordinates are canvas pixels, token width and height are grid spaces, rotation is degrees, and elevation uses scene distance units. Omitting sceneId selects the currently active observable scene.',
    inputSchema: sceneTokenListInputJsonSchema,
    outputSchema: sceneTokenListOutputJsonSchema,
  },
  {
    name: 'get_scene_token',
    description:
      'Return one observable token detail by tokenId within an observable scene, including texture scaling when available. Actor references are included only when the caller can observe the effective linked or synthetic actor. Omitting sceneId selects the currently active observable scene.',
    inputSchema: sceneTokenInputJsonSchema,
    outputSchema: sceneTokenOutputJsonSchema,
  },
];

/**
 * Content generation tool definitions
 */
export const generationTools = [
  {
    name: 'generate_npc',
    description:
      'Create a bounded, system-neutral NPC creative preview. Every option affects the preview; no Foundry document is created and no game-system rules are claimed.',
    inputSchema: npcGenerationInputJsonSchema,
    outputSchema: npcGenerationOutputJsonSchema,
  },
  {
    name: 'generate_loot',
    description:
      'Create bounded fictional loot as a world-independent creative preview. Returns traceable fictional currency arithmetic and explicitly unknown item and overall values; no Foundry document is created.',
    inputSchema: lootGenerationInputJsonSchema,
    outputSchema: lootGenerationOutputJsonSchema,
  },
  {
    name: 'lookup_rule',
    description:
      'Validate a bounded rules query and report that rules lookup is unavailable because no verified rules provider is implemented. Returns no generated rule text or source claims.',
    inputSchema: ruleLookupInputJsonSchema,
    outputSchema: ruleLookupOutputJsonSchema,
  },
];

/**
 * Diagnostics and logging tool definitions
 */
export const diagnosticsTools = [
  {
    name: 'get_recent_logs',
    description:
      'Get recent FoundryVTT server log entries, optionally filtered by level or since a timestamp. Use when: investigating an error or recent server behaviour. Do not use when: you have a specific term to look for - use search_logs. Requires the REST API module (FOUNDRY_API_KEY); fails without it.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of log entries to retrieve',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        level: {
          type: 'string',
          description: 'Log level filter (debug, info, warn, error)',
          enum: ['debug', 'info', 'warn', 'error'],
        },
        since: {
          type: 'string',
          description: 'Get logs since this timestamp (ISO format)',
        },
      },
    },
  },
  {
    name: 'search_logs',
    description:
      'Search the FoundryVTT server logs for a query string and list the matching entries. Use when: hunting a specific error message, stack trace, or module name. Do not use when: you just want the latest entries - use get_recent_logs. The reported match count is the server\'s total for the query, while limit caps how many of those entries are rendered (default 50, hard cap 1000). Level filtering accepts info, warn and error; "debug" is not a level this log store records, so it is reported back as unsupported and no level filter is applied. Requires the REST API module (FOUNDRY_API_KEY); fails without it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for log contents',
        },
        level: {
          type: 'string',
          description:
            'Log level filter; "debug" is not recorded by this log store and is not applied',
          enum: ['debug', 'info', 'warn', 'error'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matched entries to render (capped at 1000)',
          default: 50,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_system_health',
    description:
      "Get the FoundryVTT server's health report: the overall status (healthy, warning, or critical), FoundryVTT and game-system versions, world id and uptime, active/total user counts with the number of GMs, active/installed module counts, connected clients, heap and RSS memory, and the log buffer size with recent error/warning counts and error rate. CPU and disk are not reported - the diagnostics response models no such fields - and the uptime and memory lines are omitted when the server does not supply them. Use when: you want the server's own view of its health. Do not use when: you also want connection and world status - use get_health_status. Requires the REST API module (FOUNDRY_API_KEY); fails without it.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'diagnose_errors',
    description:
      'Report that evidence-based error diagnosis is unavailable because no verified diagnostic source is implemented. Returns a versioned unavailable capability without probing logs or Foundry, inferring health, or echoing the optional category. Use get_recent_logs for actual log content.',
    inputSchema: errorDiagnosisInputJsonSchema,
    outputSchema: errorDiagnosisOutputJsonSchema,
  },
  {
    name: 'get_health_status',
    description:
      "Get a combined health report: MCP-to-FoundryVTT connection state, world title/system/core version, and the server's health status with its active/total user counts, uptime, heap memory and recent error/warning counts. The world section reports current, stale, or unavailable data with source, world/session identity, snapshot revision, capture/observation times, and response time. Retained data stays stale during bounded automatic recovery after reconnect; refresh_world_data retries recovery manually. REST diagnostics are reported separately from socket snapshot freshness. The connection line is a live read of the socket on the default Socket.IO transport, so it follows a link that drops or comes back in both directions; with FOUNDRY_API_KEY set there is no socket and it reports the outcome of the last REST request instead, not a live probe, so a server that went away between requests still reads as connected until the next request fails. Uptime and memory are omitted when the server does not report them; CPU, disk and playtime are not reported at all. Degrades gracefully - sections that need the REST API module (FOUNDRY_API_KEY) report as unavailable rather than failing. Use when: first checking which world is loaded and whether the server reports itself healthy.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Combat tool definitions
 */
export const combatTools = [
  {
    name: 'get_combat_state',
    description:
      "Get the active combat encounter: initiative order with each combatant's name, initiative, HP and AC, plus the current round and which combatant is up. Use when: reporting whose turn it is, or checking whether a combat is already running before start_combat. Do not use when: you need a combatantId for set_initiative - this prints names and ordinals, not ids; read the foundry://combat resource, whose JSON includes each combatant's _id and lists combatants in this same initiative order, so the Nth entry printed here is that resource's combatants[N-1] and combat.turn indexes it directly.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Combat control mutation tool definitions (FR-018)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). All operate on
 * the *active* combat; the connected user needs GM/owner permission.
 */
export const combatMutationTools = [
  {
    name: 'next_turn',
    description:
      'Advance the active combat to the next turn, wrapping to the next round after the last combatant. When skipDefeated is true, defeated combatants are skipped. Use when: the current combatant has finished their turn. Do not use when: only reporting the turn order - use get_combat_state. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        skipDefeated: {
          type: 'boolean',
          description:
            "Skip combatants flagged as defeated when advancing. Defaults to the combat's skipDefeated setting, or false.",
        },
      },
    },
  },
  {
    name: 'end_combat',
    description:
      'End the active combat encounter by deleting its Combat document, discarding the initiative order and round count. Use when: the fight is over and the user asks to end the encounter. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_initiative',
    description:
      "Set a combatant's initiative in the active combat (or in combatId when given), reordering the turn order. When that reorder moves the combatant who is currently acting to a different position, the encounter's turn index is rewritten to follow them - whoever was up stays up, and the result says so - rather than leaving the marker on whoever slid into the old slot. That follow-up applies only to the active combat: a combatId naming some other encounter still records the initiative, but its turn order is not readable here and is left alone. Use when: an initiative roll needs to be recorded or corrected for a known combatantId. Do not use when: simply moving on to the next combatant - use next_turn. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        combatantId: {
          type: 'string',
          description: 'The ID of the combatant whose initiative to set',
        },
        initiative: {
          type: 'number',
          description: 'The initiative value to assign',
        },
        combatId: {
          type: 'string',
          description: 'Optional Combat document ID; defaults to the active combat',
        },
      },
      required: ['combatantId', 'initiative'],
    },
  },
  {
    name: 'start_combat',
    description:
      'Start a new combat encounter, seeding combatants from tokens: pass explicit tokenIds, or omit them to seed every token on the scene. Defaults to the active scene when sceneId is omitted. Use when: a fight begins and no combat is running. Do not use when: a combat is already active - check get_combat_state first, since this always creates an additional encounter. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of Token document IDs to add as combatants. Defaults to all tokens on the scene.',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene document ID; defaults to the active scene.',
        },
      },
    },
  },
];

/**
 * Token manipulation mutation tool definitions (FR-019)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). The connected
 * user needs GM/owner permission.
 */
export const tokenMutationTools = [
  {
    name: 'move_token',
    description:
      "Move a token to new x/y pixel coordinates on its scene; the token is located across scenes by id, optionally scoped with sceneId. Coordinates are absolute pixels, not grid squares and not offsets. Use when: repositioning a token to a position the user has given you. Do not use when: you would have to guess the destination - no tool in this server reports a token's current position or the scene grid size, so ask the user for the target coordinates rather than inferring them. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token to move',
        },
        x: {
          type: 'number',
          description: 'Target x pixel coordinate on the scene',
        },
        y: {
          type: 'number',
          description: 'Target y pixel coordinate on the scene',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId', 'x', 'y'],
    },
  },
  {
    name: 'apply_status_effect',
    description:
      'Apply or remove a status condition (e.g. "prone", "stunned") on a token\'s actor. Set active=false to remove. Matches by status id, so re-applying or clearing-when-absent is a no-op. Use when: a condition is gained or lost. Do not use when: changing numeric state such as HP or exhaustion - use update_actor_attributes. ' +
      WRITE_GATE +
      ' Exception: the no-op cases (applying an already-present status, or clearing an absent one) report success without attempting a write, so they also return normally while writes are disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token whose actor to affect',
        },
        statusId: {
          type: 'string',
          description: "The status condition id (e.g. 'prone', 'stunned', 'blinded')",
        },
        active: {
          type: 'boolean',
          description: 'true to apply the effect (default), false to remove it',
          default: true,
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId', 'statusId'],
    },
  },
];

/**
 * Chat message tool definitions
 */
export const chatTools = [
  {
    name: 'get_chat_messages',
    description:
      'Get the most recent chat messages from the game log. Use when: you need recent in-game context - what players said, or roll results that already happened.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default 20)',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
];

/**
 * User tool definitions
 */
export const userTools = [
  {
    name: 'get_users',
    description:
      "List the world's users with their roles and online status. Online status is live while the Socket.IO connection is up: FoundryVTT's userActivity broadcasts are applied to the cached presence list as users connect and disconnect. If the connection drops, retained presence is marked stale until automatic reconnect recovery or refresh_world_data validates a new snapshot. The response includes freshness and source timestamps; unavailable snapshots fail explicitly. Use when: you need to know which user holds the GM role, or who is connected right now.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Journal tool definitions
 */
export const journalTools = [
  {
    name: 'search_journals',
    outputSchema: collectionSearchOutputSchema,
    description:
      'Search journal names and page content. Returns version 3 metadata records with stable IDs and bounded snapshot pagination, without page bodies. Omit query to enumerate. Follow nextCursor with the same query/limit until complete; default limit 10, maximum 100, expiry five minutes. Requires an authenticated Socket.IO GM; REST is unsupported. Use get_journal for page IDs and previews, then get_journal_page for complete text or stored source.',
    inputSchema: worldSearchInputJsonSchema,
  },
  {
    name: 'get_journal',
    outputSchema: journalSummaryOutputSchema,
    description:
      'Read a bounded page list for one journalId from search_journals. Version 3 returns stable page IDs/UUIDs, type/order/source format and previews of at most 500 Unicode code points with contentTruncated. Default limit 4; maximum 8. Follow nextCursor with the same journalId/limit until complete. Use get_journal_page for complete content. Cursors expire after five minutes and are invalidated by visible content, order, ownership or session changes. Invalid inputs and missing/denied journals return InvalidParams; capacity failures return InternalError. Requires an authenticated Socket.IO GM; REST is unsupported.',
    inputSchema: journalSummaryInputJsonSchema,
  },
  {
    name: 'get_journal_page',
    outputSchema: journalPageOutputSchema,
    description:
      'Retrieve complete journal-page content by journalId and pageId from get_journal. Version 1 returns page metadata and ordered chunks of at most 1024 Unicode code points, with exact start/end offsets and contentLength. The numeric response page is paginationPage; page holds document metadata. Default format text parses HTML inertly with structural newlines and leaves Markdown intact; format source returns the exact stored text string. Default limit 4; maximum 8 chunks. Concatenate chunks in order and follow nextCursor with identical IDs/format/limit until complete. contentTruncated reports remaining chunks. Empty text has one empty chunk; non-text pages have metadata and safe asset fields with zero chunks. Source is limited to 4 MiB; responses to 128 KiB. Cursors expire after five minutes and edits, ownership or session changes invalidate them. Invalid input, missing/denied pages and invalid cursors return InvalidParams. Requires an authenticated Socket.IO GM; REST is unsupported.',
    inputSchema: journalPageInputJsonSchema,
  },
];

/**
 * Journal mutation tool definitions (WRITE)
 */
export const journalMutationTools = [
  {
    name: 'create_journal_entry',
    description:
      'Create a new journal entry with one or more text pages, optionally filed under a folder. Defaults to GM-only visibility - pass visibility to let players read it. Use when: recording session notes, lore, or a handout in the world. Do not use when: adding text to an existing entry - this always creates a new one. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Title of the journal entry',
        },
        pages: {
          type: 'array',
          description: 'One or more pages to create on the entry',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Page title',
              },
              content: {
                type: 'string',
                description: 'Page body as HTML or plain text',
              },
            },
            required: ['name', 'content'],
          },
          minItems: 1,
        },
        folder: {
          type: 'string',
          description: 'Optional Folder document id to file the entry under',
        },
        visibility: {
          type: 'string',
          enum: ['gm-only', 'observer', 'owner'],
          description:
            "Who can see the entry. 'gm-only' (default) hides it from players; 'observer' lets every player read it; 'owner' lets every player read and edit it.",
        },
      },
      required: ['name', 'pages'],
    },
  },
];

/**
 * World-level tool definitions
 */
export const worldTools = [
  {
    name: 'search_world',
    outputSchema: collectionSearchOutputSchema,
    description:
      'Search actor, item, scene and journal names in one ordered stream. Returns version 3 metadata records with stable IDs, bounded snapshot pagination and readMetadata freshness/source timestamps. Omit query to enumerate; limit applies to the whole page. Follow nextCursor with the same query/limit until complete; default limit 10, maximum 100, expiry five minutes. Requires an authenticated Socket.IO GM; REST is unsupported.',
    inputSchema: worldSearchInputJsonSchema,
  },
  {
    name: 'get_world_summary',
    description:
      'Get world metadata (title, game system, core version) and per-collection document counts. Use when: orienting yourself in an unfamiliar world, or confirming the game system before system-specific edits.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'refresh_world_data',
    description:
      'Force a re-fetch of the cached world data from the FoundryVTT server. Reads are normally served from a cache that follows live document changes for as long as the connection holds, so this is rarely needed. Use when: the connection dropped and came back - automatic reconnect recovery has not yet restored a current snapshot; or a read still looks stale after an out-of-band change - notably edits to unlinked (synthetic) token actors, which the live update feed does not cover. Refreshes the cache only; it does not modify the world.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Get all tool definitions combined
 */
export function getAllTools(delegated = false) {
  const tools = [
    ...diceTools,
    ...actorTools,
    ...actorMutationTools,
    ...itemTools,
    ...compendiumTools,
    ...itemMutationTools,
    ...sceneTools,
    ...combatTools,
    ...combatMutationTools,
    ...tokenMutationTools,
    ...chatTools,
    ...userTools,
    ...journalTools,
    ...journalMutationTools,
    ...worldTools,
    ...generationTools,
    ...diagnosticsTools,
  ];
  if (!delegated) {
    return tools;
  }
  const descriptions: Record<string, string> = {
    get_users:
      "Read the caller's own user record and current presence. Other users and credential fields are omitted.",
    search_journals:
      'Search readable journal names and readable page content. Returns version 3 metadata records without page bodies. Journal and page permissions are both required. Follow nextCursor with the same query and limit; default limit 10, maximum 100, expiry five minutes.',
    get_journal:
      'Read caller-readable pages of one journal with version 3 IDs/UUIDs, types, order, source format and 500-Unicode-code-point previews with contentTruncated. Journal and page permissions are both required. Follow nextCursor with the same journalId/limit; default limit 4, maximum 8, expiry five minutes. Use get_journal_page for complete content. Visible edits and authorization/session changes invalidate cursors.',
    get_journal_page:
      'Read complete caller-readable page content with version 1 page metadata, 1024-Unicode-code-point chunks, exact offsets, contentLength and continuation. Journal and page permissions are both required. Format text parses HTML inertly and preserves Markdown; source returns exact stored text. Follow nextCursor with identical journalId/pageId/format/limit; default limit 4, maximum 8, expiry five minutes. page holds document metadata; paginationPage is the numeric pagination position. Missing and denied pages have the same error. Visible edits and authorization/session changes invalidate cursors.',
    search_world:
      'Search caller-readable actors, items and journals in one ordered stream. Returns version 3 metadata records with bounded snapshot pagination. Scenes are unavailable. Follow nextCursor with the same query and limit; default limit 10, maximum 100, expiry five minutes.',
    get_world_summary:
      "Read world metadata and counts of caller-readable actors, items, journals, chat messages and the caller's own user record. Unsupported collections are omitted.",
  };
  return tools
    .filter((tool) => Object.hasOwn(delegatedTools, tool.name))
    .map((tool) => ({
      ...tool,
      description: `${descriptions[tool.name] ?? tool.description.replace('Socket reads require a GM; REST uses the authenticated backend view.', 'Service mode uses the backend identity.')} DELEGATED: requires a trusted caller resolver and fresh authorization; results and pagination include only caller-readable records. Unsupported surfaces and writes are unavailable.`,
    }));
}

/**
 * Get modernized tool definitions from registry (when available)
 */
export async function getModernizedTools() {
  try {
    const { toolRegistry } = await import('./registry.js');
    const modernTools = toolRegistry.getToolDefinitions();

    // Filter out tools that have been modernized to avoid duplicates
    const modernToolNames = new Set(modernTools.map((tool) => tool.name));
    const legacyTools = getAllTools().filter((tool) => !modernToolNames.has(tool.name));

    return [...modernTools, ...legacyTools];
  } catch (_error) {
    // Fallback to legacy definitions if registry is not available
    return getAllTools();
  }
}

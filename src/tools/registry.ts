/**
 * @fileoverview Tool registry for the new tool system
 *
 * This module manages tool registration and provides a clean interface
 * for tool execution with automatic validation.
 */

import { logger } from '../utils/logger.js';
import type { Tool, ToolContext, ToolResult } from './base.js';
import { actorTools } from './definitions.js';
import {
  handleGetActorItem,
  handleGetActorSection,
  handleGetActorSheet,
  handleListActorItems,
} from './handlers/actors.js';
import { RollDiceTool } from './handlers/dice.js';

const ACTOR_READ_HANDLERS = {
  get_actor_sheet: handleGetActorSheet,
  get_actor_section: handleGetActorSection,
  list_actor_items: handleListActorItems,
  get_actor_item: handleGetActorItem,
} as const;

function registeredActorReadTool(name: keyof typeof ACTOR_READ_HANDLERS): Tool {
  const definition = actorTools.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Error(`Missing tool definition for ${name}`);
  }
  return {
    name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: (args, context) => ACTOR_READ_HANDLERS[name](args, context.foundryClient),
  };
}

/**
 * Tool registry manages all available tools
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor() {
    this.registerDefaultTools();
  }

  /**
   * Register a tool in the registry
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool '${tool.name}' is already registered, replacing...`);
    }

    this.tools.set(tool.name, tool);
    logger.debug(`Registered tool: ${tool.name}`);
  }

  /**
   * Execute a tool by name with given arguments
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return await tool.execute(args, context);
  }

  /**
   * Get all registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool definitions for MCP
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: object;
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a specific tool instance
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Register all default tools
   */
  private registerDefaultTools(): void {
    // Register the dice tool (converted to new system)
    this.register(new RollDiceTool());

    for (const name of Object.keys(ACTOR_READ_HANDLERS) as Array<
      keyof typeof ACTOR_READ_HANDLERS
    >) {
      this.register(registeredActorReadTool(name));
    }

    // TODO: Register other tools as they are converted
    logger.info(`Registered ${this.tools.size} tools`);
  }
}

/**
 * Global tool registry instance
 */
export const toolRegistry = new ToolRegistry();

#!/usr/bin/env node

/**
 * FoundryVTT Model Context Protocol Server
 *
 * This server provides integration between FoundryVTT and AI models through the Model Context Protocol (MCP).
 * It enables AI assistants to interact with FoundryVTT instances for RPG campaign management,
 * character handling, and game automation.
 *
 * @fileoverview Main entry point for the FoundryVTT MCP Server
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 * @see {@link https://github.com/anthropics/mcp} Model Context Protocol
 * @see {@link https://foundryvtt.com/} FoundryVTT Virtual Tabletop
 */

// Must precede every other import: see src/load-env.ts (#206).
import './load-env.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from './config/index.js';
import { DiagnosticsClient } from './diagnostics/client.js';
import type { TrustedCallerContext } from './foundry/caller-context.js';
import { FoundryClient, type FoundryClientConfig } from './foundry/client.js';

export type { AuthorizationMode, TrustedCallerContext } from './foundry/caller-context.js';

import {
  getAllResources,
  getAllResourceTemplates,
  getAllTools,
  routeResourceRequest,
  routeToolRequest,
} from './tools/index.js';
import { DiagnosticSystem } from './utils/diagnostics.js';
import { logger } from './utils/logger.js';

/**
 * Main FoundryVTT MCP Server class that handles all communication
 * between AI models and FoundryVTT instances.
 */
export type TrustedCallerMetadata = Readonly<
  Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, 'authInfo' | 'sessionId'>
>;

/** Resolve an authenticated principal using host-owned state, never tool arguments or request _meta. */
export type TrustedCallerResolver = (
  metadata: TrustedCallerMetadata,
) => TrustedCallerContext | undefined | Promise<TrustedCallerContext | undefined>;

export interface FoundryMCPServerOptions {
  foundryClient?: FoundryClient;
  resolveCaller?: TrustedCallerResolver;
}

export class FoundryMCPServer {
  private server: Server;
  private foundryClient: FoundryClient;
  private diagnosticsClient: DiagnosticsClient;
  private diagnosticSystem: DiagnosticSystem;
  private readonly resolveCaller: TrustedCallerResolver | undefined;

  /**
   * Creates a new FoundryMCPServer instance.
   * Initializes the MCP server, FoundryVTT client, and sets up all handlers.
   */
  constructor(options: FoundryMCPServerOptions = {}) {
    this.resolveCaller = options.resolveCaller;
    this.server = new Server(
      {
        name: config.serverName,
        version: config.serverVersion,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    // Initialize FoundryVTT client with configuration
    const clientConfig: FoundryClientConfig = {
      baseUrl: config.foundry.url,
      socketPath: config.foundry.socketPath,
      timeout: config.foundry.timeout,
      retryAttempts: config.foundry.retryAttempts,
      retryDelay: config.foundry.retryDelay,
      writeEnabled: config.foundry.writeEnabled,
      authorizationMode: config.foundry.authorizationMode,
    };
    if (config.foundry.apiKey) {
      clientConfig.apiKey = config.foundry.apiKey;
    }
    if (config.foundry.username) {
      clientConfig.username = config.foundry.username;
    }
    if (config.foundry.password !== undefined) {
      clientConfig.password = config.foundry.password;
    }
    if (config.foundry.userId) {
      clientConfig.userId = config.foundry.userId;
    }
    this.foundryClient = options.foundryClient ?? new FoundryClient(clientConfig);

    // Initialize DiagnosticsClient
    this.diagnosticsClient = new DiagnosticsClient(this.foundryClient);

    // Initialize DiagnosticSystem
    this.diagnosticSystem = new DiagnosticSystem(this.foundryClient);

    this.setupHandlers();
  }

  /**
   * Sets up all MCP request handlers for tools, resources, and functionality.
   * @private
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.info('Listing available tools');
      return {
        tools: getAllTools(this.foundryClient.isDelegatedMode()),
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      logger.info('Listing available resources');
      return {
        resources: getAllResources(this.foundryClient.isDelegatedMode()),
      };
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: getAllResourceTemplates(this.foundryClient.isDelegatedMode()),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      if (!this.foundryClient.isDelegatedMode()) {
        logger.info('Executing tool', { name, args });
      }

      try {
        return (await this.runAsCaller(extra, () =>
          routeToolRequest(
            name,
            args || {},
            this.foundryClient,
            this.diagnosticsClient,
            this.diagnosticSystem,
          ),
        )) as CallToolResult;
      } catch (error) {
        if (this.foundryClient.isDelegatedMode()) {
          logger.error('Delegated tool execution failed');
        } else {
          logger.error('Tool execution failed:', error);
        }

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          this.foundryClient.isDelegatedMode()
            ? 'Delegated read unavailable'
            : `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const { uri } = request.params;
      if (!this.foundryClient.isDelegatedMode()) {
        logger.info('Reading resource', { uri });
      }

      try {
        return await this.runAsCaller(extra, () =>
          routeResourceRequest(uri, this.foundryClient, this.diagnosticsClient),
        );
      } catch (error) {
        if (this.foundryClient.isDelegatedMode()) {
          logger.error('Delegated resource read failed');
        } else {
          logger.error('Resource read failed:', error);
        }

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          this.foundryClient.isDelegatedMode()
            ? 'Delegated read unavailable'
            : `Resource read failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });
  }

  private async runAsCaller<T>(
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.foundryClient.isDelegatedMode()) {
      return operation();
    }
    let caller: TrustedCallerContext | undefined;
    try {
      caller = await this.resolveCaller?.(
        Object.freeze({
          ...(extra.authInfo ? { authInfo: extra.authInfo } : {}),
          ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
        }),
      );
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, 'Trusted caller authorization required');
    }
    if (!caller) {
      throw new McpError(ErrorCode.InvalidRequest, 'Trusted caller authorization required');
    }
    return this.foundryClient.runWithCaller(caller, operation);
  }

  /**
   * Connects to FoundryVTT and starts the MCP server.
   * @returns Promise that resolves when the server is running
   */
  async start(transport: Transport = new StdioServerTransport()): Promise<void> {
    try {
      // Connect to FoundryVTT
      await this.foundryClient.connect();
      logger.info('Connected to FoundryVTT successfully');

      // Start the MCP server
      await this.server.connect(transport);
      logger.info('FoundryVTT MCP Server started successfully');
    } catch (error) {
      await this.foundryClient.disconnect();
      logger.error('Failed to start server:', error);
      throw error;
    }
  }

  /**
   * Gracefully shuts down the server and connections.
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    try {
      await this.server.close();
    } catch (error) {
      logger.error('Error during shutdown:', error);
    } finally {
      await this.foundryClient.disconnect();
    }
    logger.info('FoundryVTT MCP Server shutdown completed');
  }
}

/**
 * Main entry point - creates and starts the server
 */
async function main(): Promise<void> {
  const server = new FoundryMCPServer();

  // Pre-connect banner — emitted on stderr so the stdio JSON-RPC channel on
  // stdout stays clean once StdioServerTransport.connect() takes it over.
  // The smoke test (scripts/smoke-test.js) keys on this string to verify the
  // binary loads without crashing at construction time, before any network
  // call to FoundryVTT.
  process.stderr.write('🎲 FoundryVTT MCP Server starting...\n');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await server.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await server.shutdown();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', { promise, reason });
    process.exit(1);
  });

  try {
    await server.start();
  } catch (error) {
    logger.error('Failed to start FoundryVTT MCP Server:', error);
    process.exit(1);
  }
}

// Run the server if this file is executed directly.
// Use realpath so the comparison works when npm/npx installs the bin as a
// symlink into node_modules/.bin (the literal `file://${argv[1]}` compare
// fails for symlinked invocations and on macOS where /tmp -> /private/tmp).
const isMainModule = (() => {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === `file://${argv1}`;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    logger.error('Server startup failed:', error);
    process.exit(1);
  });
}

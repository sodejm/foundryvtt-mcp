/**
 * @fileoverview Centralized logging utility for FoundryVTT MCP Server
 *
 * This module provides a structured logging system with configurable log levels
 * and consistent stderr formatting across the application. It respects the LOG_LEVEL
 * environment variable for controlling verbosity.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */

import { config } from '../config/index.js';
import { getAllTools } from '../tools/definitions.js';

// Only server-defined identifiers may appear in diagnostic metadata.
const diagnosticToolNames = new Set(getAllTools().map((tool) => tool.name));

/**
 * Available log levels in order of severity
 *
 * - debug: Detailed information for debugging
 * - info: General information about application flow
 * - warn: Warning messages for potential issues
 * - error: Error messages for failures and exceptions
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Centralized logger class for structured application logging
 *
 * Provides methods for different log levels and automatically filters
 * messages based on the configured minimum log level.
 *
 * @example
 * ```typescript
 * import { logger } from './utils/logger.js';
 *
 * logger.info('Server starting...');
 * logger.error('Connection failed:', error);
 * logger.debug('Cache entry accessed', { accessCount: 2 });
 * ```
 */
export class Logger {
  private logLevel: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  /**
   * Creates a new Logger instance
   *
   * @param logLevel - Minimum log level to display (default: 'info')
   */
  constructor(logLevel: LogLevel = 'info') {
    this.logLevel = logLevel;
  }

  /**
   * Determines if a message should be logged based on current log level
   *
   * @private
   * @param level - The log level to check
   * @returns True if the message should be logged, false otherwise
   */
  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.logLevel];
  }

  /**
   * Formats a log message with timestamp, level, and optional metadata
   *
   * @private
   * @param level - The log level
   * @param message - The main log message
   * @param meta - Optional metadata object
   * @returns Formatted log message string
   */
  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    // Read only allowlisted own data properties. Never serialize caller objects,
    // errors, getters, nested values, or request/response bodies.
    const fields = [
      'ttlSeconds',
      'maxSize',
      'age',
      'accessCount',
      'ttl',
      'size',
      'previousSize',
      'cleaned',
      'remaining',
      'actors',
      'scenes',
      'items',
      'replayedEvents',
      'count',
      'bufferSize',
      'matches',
      'status',
      'activeUsers',
      'recentErrors',
      'totalErrors',
      'healthScore',
      'suggestionCount',
    ];
    const safe: Record<string, number | string> = {};
    if (meta !== null && typeof meta === 'object') {
      try {
        const toolDescriptor = Object.getOwnPropertyDescriptor(meta, 'tool');
        const tool = toolDescriptor && 'value' in toolDescriptor ? toolDescriptor.value : undefined;
        if (typeof tool === 'string' && diagnosticToolNames.has(tool)) {
          safe.tool = tool;
        }
        for (const field of fields) {
          const descriptor = Object.getOwnPropertyDescriptor(meta, field);
          const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
          if (typeof value === 'number' && Number.isFinite(value)) {
            safe[field] = value;
          }
        }
      } catch {
        // Proxies and other unusual metadata must not break request handling.
      }
    }
    const metaStr = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  }

  /**
   * Logs a debug message (lowest priority)
   *
   * Used for detailed information that's only needed when debugging issues.
   * Only shown when LOG_LEVEL is set to 'debug'.
   *
   * @param message - The debug message
   * @param meta - Optional metadata object
   * @example
   * ```typescript
   * logger.debug('Processing user request');
   * ```
   */
  debug(message: string, meta?: unknown): void {
    if (this.shouldLog('debug')) {
      process.stderr.write(`${this.formatMessage('debug', message, meta)}\n`);
    }
  }

  /**
   * Logs an informational message
   *
   * Used for general information about application flow and important events.
   * Shown when LOG_LEVEL is 'debug' or 'info'.
   *
   * @param message - The info message
   * @param meta - Optional metadata object
   * @example
   * ```typescript
   * logger.info('Server started successfully');
   * ```
   */
  info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      process.stderr.write(`${this.formatMessage('info', message, meta)}\n`);
    }
  }

  /**
   * Logs a warning message
   *
   * Used for potentially problematic situations that don't prevent operation
   * but should be noted. Shown when LOG_LEVEL is 'debug', 'info', or 'warn'.
   *
   * @param message - The warning message
   * @param meta - Optional metadata object
   * @example
   * ```typescript
   * logger.warn('Deprecated API endpoint used');
   * ```
   */
  warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      process.stderr.write(`${this.formatMessage('warn', message, meta)}\n`);
    }
  }

  /**
   * Logs an error message (highest priority)
   *
   * Used for error conditions and exceptions that affect application operation.
   * Always shown regardless of LOG_LEVEL setting.
   *
   * @param message - The error message
   * @param error - Optional error object or metadata
   * @example
   * ```typescript
   * logger.error('Database connection failed', error);
   * logger.error('Invalid user input');
   * ```
   */
  error(message: string, error?: unknown): void {
    if (this.shouldLog('error')) {
      process.stderr.write(`${this.formatMessage('error', message, error)}\n`);
    }
  }
}

/**
 * Global logger instance
 *
 * Pre-configured logger instance ready for use throughout the application.
 * Respects the LOG_LEVEL environment variable for filtering messages.
 *
 * @example
 * ```typescript
 * import { logger } from './utils/logger.js';
 *
 * logger.info('Application starting');
 * logger.error('Something went wrong', error);
 * ```
 */
export const logger = new Logger(config.logLevel);

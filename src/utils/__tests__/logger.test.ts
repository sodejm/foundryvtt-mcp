import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../logger.js';

vi.mock('../../config/index.js', () => ({ config: { logLevel: 'info' } }));

describe('production logger', () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((message) => {
      output.push(String(message));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    'debug',
    'info',
    'warn',
    'error',
  ] as const)('routes all enabled levels to stderr at %s', (minimum) => {
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    const logger = new Logger(minimum);
    for (const level of levels) {
      logger[level]('Operation completed');
    }
    expect(output).toHaveLength(4 - levels.indexOf(minimum));
    expect(process.stdout.write).not.toHaveBeenCalled();
    for (const line of output) {
      expect(line).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T.*Z\] (DEBUG|INFO|WARN|ERROR): Operation completed\n$/,
      );
    }
  });

  it('defaults to info and preserves safe operational counts', () => {
    const logger = new Logger();
    logger.debug('Operation started');
    logger.info('Operation completed', { count: 2, size: 4 });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('{"size":4,"count":2}');
  });

  it('omits arguments, credentials, nested values, errors, and unsafe scalars at debug', () => {
    const logger = new Logger('debug');
    const canary = 'private-journal-password-canary';
    const metadata = {
      tool: canary,
      args: { content: canary },
      password: canary,
      key: canary,
      uri: canary,
      count: { body: canary },
      size: canary,
      age: Number.POSITIVE_INFINITY,
      ttl: BigInt(9),
      status: Number.NaN,
    };
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      logger[level]('Operation failed', metadata);
      logger[level]('Operation failed', new Error(canary));
      logger[level]('Operation failed', canary);
    }
    expect(output).toHaveLength(12);
    expect(output.join('')).not.toContain(canary);
    expect(output.join('')).not.toContain('stack');
    expect(output.join('')).not.toContain('{');
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it('identifies only tools from the server catalog', () => {
    const logger = new Logger();
    logger.info('Tool execution completed', { tool: 'get_world_summary', args: 'private' });
    logger.error('Tool execution failed', { tool: 'caller-supplied-secret' });
    expect(output[0]).toContain('{"tool":"get_world_summary"}');
    expect(output[1]).not.toContain('{');
    expect(output.join('')).not.toContain('private');
    expect(output.join('')).not.toContain('caller-supplied-secret');
  });

  it('never invokes metadata getters, serializers, or inherited properties', () => {
    const getter = vi.fn(() => {
      throw new Error('private getter');
    });
    const serializer = vi.fn(() => {
      throw new Error('private serializer');
    });
    const metadata = Object.create({ size: 99 });
    Object.defineProperty(metadata, 'count', { get: getter });
    metadata.toJSON = serializer;
    metadata.args = metadata;
    const logger = new Logger('debug');
    expect(() => logger.debug('Operation completed', metadata)).not.toThrow();
    expect(() =>
      logger.error(
        'Operation failed',
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error('private proxy');
            },
          },
        ),
      ),
    ).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(serializer).not.toHaveBeenCalled();
    expect(output.join('')).not.toContain('private');
    expect(output.join('').replace(/^\[[^\]]+\] /gm, '')).not.toContain('99');
  });
});

it('runtime log labels cannot interpolate request or world data', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const violations: string[] = [];
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') {
          inspect(path);
        }
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name === 'index-old.ts') {
        continue;
      }
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(source) === 'logger' &&
          ['debug', 'info', 'warn', 'error'].includes(node.expression.name.text) &&
          (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
        ) {
          violations.push(
            `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  inspect(root);
  expect(violations).toEqual([]);
});

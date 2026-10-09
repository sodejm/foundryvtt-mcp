/**
 * @fileoverview Tests for the new tool registry system
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { DiagnosticSystem } from '../../utils/diagnostics.js';
import type { ToolContext } from '../base.js';
import { getAllTools } from '../definitions.js';
import { RollDiceTool } from '../handlers/dice.js';
import { toolRegistry } from '../registry.js';

describe('Tool Registry', () => {
  let mockContext: ToolContext;

  beforeEach(() => {
    mockContext = {
      foundryClient: {
        rollDice: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          engine: 'local',
          normalizedFormula: '1d20 + 5',
          dice: [
            {
              termIndex: 0,
              formula: '1d20',
              count: 1,
              faces: 20,
              modifier: null,
              results: [{ result: 10, active: true }],
            },
          ],
          fallback: null,
          total: 15,
          breakdown: '(10) + 5',
          timestamp: '2025-01-01T00:00:00Z',
        }),
      } as unknown as FoundryClient,
      diagnosticsClient: {} as unknown as DiagnosticsClient,
      diagnosticSystem: {} as unknown as DiagnosticSystem,
    };
  });

  describe('Tool Registration', () => {
    it('should have roll_dice tool registered', () => {
      expect(toolRegistry.has('roll_dice')).toBe(true);
    });

    it('should return tool definitions', () => {
      const definitions = toolRegistry.getToolDefinitions();
      const rollDiceDefinition = definitions.find((d) => d.name === 'roll_dice');

      expect(rollDiceDefinition).toBeDefined();
      expect(rollDiceDefinition?.description).toContain('Roll a bounded formula');
      expect(rollDiceDefinition?.inputSchema).toBeDefined();
    });

    it('should get tool names', () => {
      const names = toolRegistry.getToolNames();
      expect(names).toContain('roll_dice');
    });

    // The registry class executes roll_dice while getAllTools() is what the
    // server lists, so a drifted description would be invisible at runtime.
    it('should describe roll_dice identically in the registry and in getAllTools()', () => {
      const listed = getAllTools().find((t) => t.name === 'roll_dice');
      const registered = toolRegistry.getToolDefinitions().find((d) => d.name === 'roll_dice');

      expect(listed?.description).toBeDefined();
      expect(registered?.description).toBe(listed?.description);
      expect(registered?.inputSchema).toEqual(listed?.inputSchema);
      expect(registered?.outputSchema).toEqual(listed?.outputSchema);
    });
  });

  describe('Tool Execution', () => {
    it('should execute roll_dice tool with valid parameters', async () => {
      const result = await toolRegistry.execute(
        'roll_dice',
        {
          formula: '1d20+5',
          reason: 'attack roll',
        },
        mockContext,
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text ?? '')).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 1,
        engine: 'local',
        normalizedFormula: '1d20 + 5',
        total: 15,
      });
      expect(mockContext.foundryClient.rollDice).toHaveBeenCalledExactlyOnceWith(
        '1d20+5',
        'attack roll',
        'auto',
      );
    });

    it('should validate parameters and throw error for missing formula', async () => {
      await expect(toolRegistry.execute('roll_dice', {}, mockContext)).rejects.toThrow(
        'Invalid parameters',
      );
    });

    it('should validate parameters and throw error for wrong type', async () => {
      await expect(
        toolRegistry.execute(
          'roll_dice',
          {
            formula: 123, // should be string
          },
          mockContext,
        ),
      ).rejects.toThrow('Invalid parameters');
    });

    it('should throw error for unknown tool', async () => {
      await expect(toolRegistry.execute('unknown_tool', {}, mockContext)).rejects.toThrow(
        'Unknown tool',
      );
    });
  });

  describe('Tool Instance Management', () => {
    it('should return tool instance for registered tool', () => {
      const tool = toolRegistry.get('roll_dice');
      expect(tool).toBeInstanceOf(RollDiceTool);
    });

    it('should return undefined for unregistered tool', () => {
      const tool = toolRegistry.get('nonexistent_tool');
      expect(tool).toBeUndefined();
    });
  });
});

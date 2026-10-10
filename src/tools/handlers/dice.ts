import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  diceRollInputJsonSchema,
  diceRollOutputJsonSchema,
  diceRollOutputSchema,
  parseDiceRollInput,
} from '../../foundry/dice-contract.js';
import { InvalidDiceFormulaError, parseDiceFormula } from '../../foundry/dice-formula.js';
import { BaseTool, type ToolContext, type ToolResult } from '../base.js';
import { ROLL_DICE_DESCRIPTION } from '../definitions.js';

export class RollDiceTool extends BaseTool {
  readonly name = 'roll_dice';
  readonly description = ROLL_DICE_DESCRIPTION;
  readonly inputSchema = diceRollInputJsonSchema;
  readonly outputSchema = diceRollOutputJsonSchema;

  protected async executeValidated(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const input = parseDiceRollInput(args);
    try {
      parseDiceFormula(input.formula);
    } catch (error) {
      if (error instanceof InvalidDiceFormulaError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
    const result = diceRollOutputSchema.parse(
      await context.foundryClient.rollDice(input.formula, input.reason, input.engine),
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
}

/** Legacy router entry point uses the same strict contract as the registry. */
export async function handleRollDice(
  args: Record<string, unknown>,
  foundryClient: FoundryClient,
): Promise<ToolResult> {
  return new RollDiceTool().execute(args, { foundryClient });
}

import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  type DiceFormulaResult,
  MAX_DICE_PER_TERM,
  MAX_DICE_SIDES,
  MAX_DICE_TERMS,
  type ParsedDiceFormula,
  validateParsedDiceOutcomes,
} from './dice-formula.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const rollEnvelopeSchema = z.strictObject({
  type: z.literal('roll-result'),
  requestId: z.string().min(1),
  success: z.literal(true),
  data: z.strictObject({
    id: z.string().min(1),
    chatMessageCreated: z.literal(false),
    roll: z.strictObject({
      formula: z.string().min(1),
      total: z.number().int().safe(),
      timestamp: z.number().int().safe().min(0).max(8_640_000_000_000_000),
      dice: z
        .array(
          z.strictObject({
            faces: z.number().int().safe().positive().max(MAX_DICE_SIDES),
            results: z
              .array(
                z.strictObject({
                  result: z.number().int().safe().positive().max(MAX_DICE_SIDES),
                  active: z.boolean(),
                }),
              )
              .max(MAX_DICE_PER_TERM),
          }),
        )
        .max(MAX_DICE_TERMS),
      isCritical: z.boolean().optional(),
      isFumble: z.boolean().optional(),
    }),
  }),
});

export interface DiceRestOptions {
  baseUrl: string;
  apiKey: string;
  clientId: string;
  userId?: string | undefined;
  timeout?: number | undefined;
}

/** One authenticated native roll, with no retry, chat creation, or local reevaluation. */
export class DiceRestAdapter {
  private readonly http: AxiosInstance;

  constructor(private readonly options: DiceRestOptions) {
    try {
      const url = new URL(options.baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !options.apiKey.trim() ||
        !options.clientId.trim() ||
        (options.timeout !== undefined &&
          (!Number.isSafeInteger(options.timeout) || options.timeout <= 0))
      ) {
        throw new Error('Invalid configuration');
      }
      this.http = axios.create({
        baseURL: url.toString(),
        headers: { 'x-api-key': options.apiKey },
        timeout: options.timeout ?? 10_000,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        responseType: 'json',
      });
    } catch {
      throw new Error('Invalid Foundry dice REST configuration.');
    }
  }

  async roll(
    parsed: ParsedDiceFormula,
    reason?: string,
  ): Promise<DiceFormulaResult & { timestamp: string }> {
    try {
      const response = await this.http.post(
        '/roll',
        {
          formula: parsed.normalizedFormula,
          createChatMessage: false,
          ...(reason === undefined ? {} : { flavor: reason }),
        },
        {
          params: {
            clientId: this.options.clientId,
            ...(this.options.userId === undefined ? {} : { userId: this.options.userId }),
          },
        },
      );
      const native = rollEnvelopeSchema.parse(response.data).data.roll;
      if (native.formula !== parsed.normalizedFormula) {
        throw new Error('Formula mismatch');
      }
      const verified = validateParsedDiceOutcomes(parsed, native.dice);
      if (native.total !== verified.total) {
        throw new Error('Total mismatch');
      }
      return { ...verified, timestamp: new Date(native.timestamp).toISOString() };
    } catch {
      // A timeout can occur after evaluation. Never reroll an uncertain result.
      throw new Error('Foundry dice roll failed; no retry or local fallback was attempted.');
    }
  }
}

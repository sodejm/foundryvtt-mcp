import { RULES_LOOKUP_UNAVAILABLE } from '../../foundry/capabilities.js';
import type { FoundryClient } from '../../foundry/client.js';
import { boundedReadResponse } from '../../foundry/read-contract.js';
import { parseRuleLookupInput, ruleLookupOutputSchema } from '../../foundry/rule-contract.js';

/** Reports the verified absence of a rules provider without fabricating rule content. */
export async function handleLookupRule(args: unknown, _client: FoundryClient) {
  parseRuleLookupInput(args);
  const structuredContent = ruleLookupOutputSchema.parse({
    schemaVersion: 1,
    capability: RULES_LOOKUP_UNAVAILABLE,
  });

  return boundedReadResponse({
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

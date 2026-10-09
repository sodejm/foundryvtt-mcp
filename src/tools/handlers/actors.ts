/** Actor world-document search and detail handlers. */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  actorDetailsSchema,
  actorReadRecord,
  actorSearchDocumentSchema,
  actorSearchInputSchema,
  actorSearchSchema,
  boundedReadResponse,
  documentIdSchema,
  paginationSchema,
  paginationText,
  parseReadInput,
  readMetadataText,
} from '../../foundry/read-contract.js';
import { availableReadMetadata, withToolError } from './utils.js';

export async function handleSearchActors(
  args: { query?: string; type?: string; limit?: number; cursor?: string },
  foundryClient: FoundryClient,
) {
  const { query, type, limit, cursor } = parseReadInput(actorSearchInputSchema, args);
  return withToolError('search actors', async () => {
    const searchParams = {
      query: query ?? '',
      ...(limit !== undefined && { limit }),
      ...(cursor !== undefined && { cursor }),
      ...(type !== undefined && { type }),
    };
    const result = actorSearchDocumentSchema.parse(await foundryClient.searchActors(searchParams));
    const structuredContent = actorSearchSchema.parse({
      schemaVersion: 3,
      documentType: 'Actor',
      records: result.actors.map(actorReadRecord),
      ...paginationSchema.parse(result),
    });
    const actorList = structuredContent.records
      .map(
        (actor) =>
          `- **${actor.name}** (${actor.type}) - Level ${actor.level ?? 'Unknown'} - HP: ${actor.hp?.value ?? 'Unknown'}/${actor.hp?.max ?? 'Unknown'} - ID: ${actor.id}`,
      )
      .join('\n');
    return boundedReadResponse({
      structuredContent,
      content: [
        {
          type: 'text' as const,
          text: `🎭 **Actor Search Results**
**Query:** ${query || 'All actors'}
**Type Filter:** ${type || 'All types'}
**Results:** ${structuredContent.records.length}/${structuredContent.total} total

${actorList || 'No actors found matching the criteria.'}

${paginationText(structuredContent)}`,
        },
      ],
    });
  });
}

export async function handleGetActorDetails(
  args: { actorId: string },
  foundryClient: FoundryClient,
) {
  const { actorId } = args;
  if (!documentIdSchema.safeParse(actorId).success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid actorId: expected 16 alphanumeric characters',
    );
  }
  return withToolError('get actor details', async () => {
    const actor = actorReadRecord(await foundryClient.getActor(actorId));
    if (actor.id !== actorId) {
      throw new Error('Actor response ID mismatch');
    }
    const structuredContent = actorDetailsSchema.parse({
      schemaVersion: 2,
      documentType: 'Actor',
      record: actor,
      readMetadata: availableReadMetadata(foundryClient),
    });
    const abilities = actor.abilities
      ? Object.entries(actor.abilities)
          .map(([key, ability]) => {
            const mod = ability.mod;
            return `**${key.toUpperCase()}:** ${ability.value ?? 'Unknown'} (${mod === undefined ? 'Unknown' : `${mod >= 0 ? '+' : ''}${mod}`})`;
          })
          .join('\n')
      : 'No ability scores available';
    return {
      structuredContent,
      content: [
        {
          type: 'text' as const,
          text: `🎭 **Actor Details: ${actor.name}**
**ID:** ${actor.id}
**Type:** ${actor.type}
**Level:** ${actor.level ?? 'Unknown'}
**Hit Points:** ${actor.hp?.value ?? 'Unknown'}/${actor.hp?.max ?? 'Unknown'}
**Armor Class:** ${actor.ac?.value ?? 'Unknown'}

**Ability Scores:**
${abilities}

**Biography:** ${actor.biography ?? 'No biography available.'}\n\n${readMetadataText(structuredContent.readMetadata)}`,
        },
      ],
    };
  });
}

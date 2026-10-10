/**
 * Chat message tool handler
 */

import { parseChatLimit } from '../../foundry/chat-contract.js';
import type { FoundryClient } from '../../foundry/client.js';
import { htmlToJournalText } from '../../foundry/journal-read.js';
import { withWorldRead } from './utils.js';

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function handleGetChatMessages(
  args: { limit?: number },
  foundryClient: FoundryClient,
) {
  const limit = parseChatLimit(args.limit);
  return withWorldRead('get chat messages', foundryClient, async () => {
    const messages = foundryClient.getChatMessages(limit);

    if (messages.length === 0) {
      return {
        content: [{ type: 'text', text: 'No chat messages found.' }],
      };
    }

    // Resolve user names from worldData
    const { users } = foundryClient.getUsers();
    const userMap = new Map(users.map((u) => [u._id, u.name]));

    const formatted = messages
      .map((m) => {
        const speaker = escapeHtmlText(m.speaker?.alias || userMap.get(m.user) || 'Unknown');
        const time = new Date(m.timestamp).toLocaleTimeString();
        const content = escapeHtmlText(htmlToJournalText(m.content).trim().slice(0, 200));
        return `[${time}] **${speaker}**: ${content}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `**Recent Chat Messages** (${messages.length})\n\n${formatted}`,
        },
      ],
    };
  });
}

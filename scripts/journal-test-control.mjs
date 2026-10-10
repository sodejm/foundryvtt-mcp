/** Fixed fixture operations for the disposable local journal integration world. */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { authenticateFoundry } from '../dist/foundry/auth.js';

const baseUrl = process.env.FOUNDRY_URL?.replace(/\/$/, '');
const username = process.env.FOUNDRY_USERNAME;
if (!baseUrl || !username) throw new Error('Explicit Foundry test credentials are required');
const port = Number(process.env.FOUNDRY_JOURNAL_TEST_CONTROL_PORT ?? 3012);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid controller port');
const context = await chromium.launchPersistentContext(
  process.env.FOUNDRY_JOURNAL_TEST_PROFILE ?? join(tmpdir(), 'foundry-journal-browser-profile'),
  { headless: true },
);
const session = await authenticateFoundry(baseUrl, username, process.env.FOUNDRY_PASSWORD ?? '');
await context.addCookies([{ name: 'session', value: session.session, url: baseUrl }]);
const page = context.pages()[0] ?? await context.newPage();
page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
async function ready() {
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 90_000 });
  if (await page.evaluate(() => game.world.id) !== 'test1world') throw new Error('Disposable test1world is required');
}
await page.goto(`${baseUrl}/game`);
if (await page.locator('#login-form').count()) {
  const userId = await page.locator('select[name="userid"]').evaluate((select, name) =>
    [...select.options].find(option => option.text.trim() === name)?.value, username);
  if (!userId) throw new Error('Test Gamemaster login is unavailable');
  await page.locator('select[name="userid"]').selectOption(userId);
  await page.locator('input[name="password"]').fill(process.env.FOUNDRY_PASSWORD ?? '');
  await page.locator('button[data-action="join"]').click();
}
await ready();
const prefix = 'MCP Journal Issue 6';
let serial = Promise.resolve();
const server = createServer((request, response) => {
  serial = serial.then(async () => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/status' && request.method !== 'POST') {
        response.writeHead(405).end(); return;
      }
      await ready();
      let result;
      if (url.pathname === '/status') result = await page.evaluate(() => ({
        world: game.world.id, version: game.version, system: game.system.id,
        systemVersion: game.system.version,
        modules: [...game.modules.values()].filter(module => module.active).map(module => ({ id: module.id, version: module.version })),
      }));
      else if (url.pathname === '/cleanup' || url.pathname === '/seed') {
        await page.evaluate(async prefix => {
          const ids = game.journal.filter(journal => journal.name.startsWith(prefix)).map(journal => journal.id);
          if (ids.length) await JournalEntry.deleteDocuments(ids);
        }, prefix);
        result = { ok: true };
        if (url.pathname === '/seed') result = await page.evaluate(async prefix => {
          const long = '0123456789😀'.repeat(1000);
          const definitions = [
            { name: 'Empty', content: '', expected: '' },
            ...[499, 500, 501].map(length => ({ name: `Boundary ${length}`, content: '😀'.repeat(length), expected: '😀'.repeat(length) })),
            { name: 'Long HTML', content: `<h2>Heading &copy; &#x1F600;</h2><p>Alpha <strong>bold</strong><br>line</p><ul><li>One</li><li>Two</li></ul><p>${long}</p>`, expected: `Heading © 😀\nAlpha bold\nline\nOne\nTwo\n${long}` },
            { name: 'Entities', content: '<div><p>A &amp; B &eacute; &NotEqualTilde; &#x1F600;</p><p>Next <em>nested</em> paragraph</p></div>', expected: 'A & B é ≂̸ 😀\nNext nested paragraph' },
            { name: 'Markdown', format: 2, content: '# Heading\n\n**Bold** and 😀', expected: '# Heading\n\n**Bold** and 😀' },
          ];
          const journal = await JournalEntry.create({ name: `${prefix} Complete`, pages: [
            ...definitions.map((definition, index) => ({ name: definition.name, type: 'text', sort: index * 1000, text: { format: definition.format ?? 1, ...(definition.format === 2 ? { markdown: definition.content } : { content: definition.content }) } })),
            { name: 'Image', type: 'image', sort: 7000, src: 'icons/svg/book.svg', image: { caption: 'Fixture image caption' } },
            { name: 'Video', type: 'video', sort: 8000, src: 'https://example.invalid/fixture.webm' },
            ...[9, 10, 11].map(index => ({ name: `Ordered ${index}`, type: 'text', sort: index * 1000, text: { content: `<p>Order ${index}</p>` } })),
          ] });
          const empty = await JournalEntry.create({ name: `${prefix} Empty` });
          return { id: journal.id, emptyId: empty.id, pages: [...journal.pages].map(document => ({
            ...document.toObject(), expectedText: definitions.find(definition => definition.name === document.name)?.expected ?? (document.type === 'text' ? `Order ${document.sort / 1000}` : ''),
          })) };
        }, prefix);
      } else if (url.pathname === '/mutate') {
        const kind = url.searchParams.get('kind');
        if (!['edit', 'sort', 'delete'].includes(kind)) throw new Error('Invalid fixture mutation');
        result = await page.evaluate(async ({ prefix, journalId, pageId, kind }) => {
          const journal = game.journal.get(journalId);
          const document = journal?.pages.get(pageId);
          if (!journal?.name.startsWith(prefix) || !document) throw new Error('Owned fixture page required');
          if (kind === 'delete') await document.delete();
          else if (kind === 'edit') await document.update({ 'text.content': '<p>Edited fixture 😀</p>' });
          else await document.update({ sort: document.sort + 123456 });
          return { ok: true };
        }, { prefix, journalId: url.searchParams.get('journalId'), pageId: url.searchParams.get('pageId'), kind });
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      console.error('Journal fixture operation failed:', error.name);
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Journal fixture operation failed' }));
    }
  });
});
server.listen(port, '127.0.0.1', () => console.info(`Journal fixture controller ready on 127.0.0.1:${port}`));
async function close() { server.close(); await context.close(); }
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

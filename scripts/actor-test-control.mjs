/** Fixed actor fixture operations for the disposable local integration world. */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { authenticateFoundry } from '../dist/foundry/auth.js';

const baseUrl = process.env.FOUNDRY_URL?.replace(/\/$/, '');
const username = process.env.FOUNDRY_USERNAME;
if (!baseUrl || !username) throw new Error('Explicit Foundry test credentials are required');
const port = Number(process.env.FOUNDRY_ACTOR_TEST_CONTROL_PORT ?? 3013);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid controller port');
const context = await chromium.launchPersistentContext(
  process.env.FOUNDRY_ACTOR_TEST_PROFILE ?? join(tmpdir(), 'foundry-actor-browser-profile'),
  { headless: true, viewport: { width: 1366, height: 768 } },
);
const session = await authenticateFoundry(baseUrl, username, process.env.FOUNDRY_PASSWORD ?? '');
await context.addCookies([{ name: 'session', value: session.session, url: baseUrl }]);
const page = context.pages()[0] ?? await context.newPage();
page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
async function ready() {
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { polling: 100, timeout: 90_000 });
  const valid = await page.evaluate(() => game.world.id === 'test1world' && game.system.id === 'dnd5e' && game.user.isGM);
  if (!valid) throw new Error('Disposable dnd5e test1world and Gamemaster are required');
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
const prefix = 'MCP Actor Issue 7';
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
          const ids = game.actors.filter(actor => actor.name.startsWith(prefix)).map(actor => actor.id);
          if (ids.length) await Actor.deleteDocuments(ids);
        }, prefix);
        result = { ok: true };
        if (url.pathname === '/seed') result = await page.evaluate(async prefix => {
          const actors = await Actor.createDocuments([
            { name: `${prefix} Inventory 😀`, type: 'npc', system: {
              attributes: { hp: { value: 0, max: 23, temp: 0 }, ac: { calc: 'flat', flat: 12 } },
              currency: { gp: 0 }, details: { biography: { value: 'Public fixture biography' } },
            }, flags: { mcpTest: { secret: 'NEVER_PUBLIC_ACTOR_FLAG' } } },
            { name: `${prefix} Empty`, type: 'npc' },
            { name: `${prefix} Other Parent`, type: 'npc' },
          ]);
          const actor = actors.find(actor => actor.name === `${prefix} Inventory 😀`);
          const empty = actors.find(actor => actor.name === `${prefix} Empty`);
          const other = actors.find(actor => actor.name === `${prefix} Other Parent`);
          if (!actor || !empty || !other) throw new Error('Actor fixture creation was incomplete');
          const createdItems = (await actor.createEmbeddedDocuments('Item', Array.from({ length: 251 }, (_, index) => ({
            name: index < 2 ? 'Duplicate Gear 😀' : index === 250 ? `Unusual ${'😀'.repeat(600)}` : `Gear ${String(index).padStart(3, '0')}`,
            type: 'loot', sort: index * 1000,
            system: { quantity: index === 0 ? 0 : index, description: { value: index === 0 ? `<p>${'Long fixture 😀'.repeat(2000)}</p>` : `<p>Fixture item ${index}</p>` } },
            flags: { mcpTest: { secret: 'NEVER_PUBLIC_ITEM_FLAG' } },
          })))).sort((left, right) => left.sort - right.sort || left.id.localeCompare(right.id));
          // DND5E supplies creation defaults; set the zero-value cases after creation.
          await actor.update({ 'system.attributes.hp.value': 0 });
          await createdItems[0].update({ 'system.quantity': 0 });
          const otherItem = await other.createEmbeddedDocuments('Item', [{ name: 'Other Parent Gear', type: 'loot', system: { quantity: 7 } }]);
          return { id: actor.id, emptyId: empty.id, otherId: other.id, otherItemId: otherItem[0].id,
            items: createdItems.map(item => ({ _id: item.id, name: item.name, type: item.type, sort: item.sort, quantity: item.system.quantity })),
          };
        }, prefix);
      } else if (url.pathname === '/mutate') {
        const kind = url.searchParams.get('kind');
        if (!['item-edit', 'item-sort', 'item-delete', 'actor-edit', 'actor-delete'].includes(kind)) throw new Error('Invalid fixture mutation');
        result = await page.evaluate(async ({ prefix, actorId, itemId, kind }) => {
          const actor = game.actors.get(actorId);
          if (!actor?.name.startsWith(prefix)) throw new Error('Owned fixture actor required');
          if (kind === 'actor-delete') await actor.delete();
          else if (kind === 'actor-edit') await actor.update({ 'system.attributes.hp.value': 5 });
          else {
            const item = actor.items.get(itemId);
            if (!item) throw new Error('Owned fixture item required');
            if (kind === 'item-delete') await item.delete();
            else if (kind === 'item-edit') await item.update({ 'system.quantity': 42, 'system.description.value': '<p>Edited fixture 😀</p>' });
            else await item.update({ sort: item.sort + 1234567 });
          }
          return { ok: true };
        }, { prefix, actorId: url.searchParams.get('actorId'), itemId: url.searchParams.get('itemId'), kind });
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      console.error('Actor fixture operation failed:', error.name);
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Actor fixture operation failed' }));
    }
  });
});
server.listen(port, '127.0.0.1', () => console.info(`Actor fixture controller ready on 127.0.0.1:${port}`));
async function close() { server.close(); await context.close(); }
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

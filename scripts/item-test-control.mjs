/** Fixed item fixture operations for the disposable local integration world. */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { authenticateFoundry } from '../dist/foundry/auth.js';

const baseUrl = process.env.FOUNDRY_URL?.replace(/\/$/, '');
const username = process.env.FOUNDRY_USERNAME;
if (!baseUrl || !username) throw new Error('Explicit Foundry test credentials are required');
const port = Number(process.env.FOUNDRY_ITEM_TEST_CONTROL_PORT ?? 3016);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid controller port');
const context = await chromium.launchPersistentContext(
  process.env.FOUNDRY_ITEM_TEST_PROFILE ?? join(tmpdir(), 'foundry-item-browser-profile'),
  { headless: true, viewport: { width: 1366, height: 768 } },
);
// Fixture operations need documents; avoid unrelated headless WebGL initialization failures.
await context.addInitScript(() => localStorage.setItem('core.noCanvas', 'true'));
const session = await authenticateFoundry(baseUrl, username, process.env.FOUNDRY_PASSWORD ?? '');
await context.addCookies([{ name: 'session', value: session.session, url: baseUrl }]);
const page = context.pages()[0] ?? (await context.newPage());
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
async function ready() {
  await page.waitForFunction(() => globalThis.game?.ready === true, null, {
    polling: 100,
    timeout: 90_000,
  });
  const valid = await page.evaluate(
    () => game.world.id === 'test1world' && game.system.id === 'dnd5e' && game.user.isGM,
  );
  if (!valid) throw new Error('Disposable dnd5e test1world and Gamemaster are required');
}
await page.goto(`${baseUrl}/game`);
if (await page.locator('#login-form').count()) {
  const userId = await page
    .locator('select[name="userid"]')
    .evaluate(
      (select, name) => [...select.options].find((option) => option.text.trim() === name)?.value,
      username,
    );
  if (!userId) throw new Error('Test Gamemaster login is unavailable');
  await page.locator('select[name="userid"]').selectOption(userId);
  await page.locator('input[name="password"]').fill(process.env.FOUNDRY_PASSWORD ?? '');
  await page.locator('button[data-action="join"]').click();
}
await ready();
const prefix = 'MCPItemIssue13';
let serial = Promise.resolve();
const server = createServer((request, response) => {
  serial = serial.then(async () => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/status' && request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      await ready();
      let result;
      if (url.pathname === '/status')
        result = await page.evaluate(() => ({
          world: game.world.id,
          version: game.version,
          system: game.system.id,
          systemVersion: game.system.version,
        }));
      else if (url.pathname === '/seed' || url.pathname === '/cleanup') {
        result = await page.evaluate(async (prefix) => {
          const items = game.items
            .filter((item) => item.name.startsWith(prefix))
            .map((item) => item.id);
          const actors = game.actors
            .filter((actor) => actor.name.startsWith(prefix))
            .map((actor) => actor.id);
          if (items.length) await Item.deleteDocuments(items);
          if (actors.length) await Actor.deleteDocuments(actors);
          return {
            remaining:
              game.items.filter((item) => item.name.startsWith(prefix)).length +
              game.actors.filter((actor) => actor.name.startsWith(prefix)).length,
          };
        }, prefix);
        if (url.pathname === '/seed')
          result = await page.evaluate(async (prefix) => {
            const docs = Array.from({ length: 251 }, (_, index) => ({
              name: `${prefix} Gear ${String(index).padStart(3, '0')}`,
              type: index === 250 ? 'tool' : 'loot',
              system: {
                price: {
                  value: index === 0 ? 0 : index === 1 ? 0.5 : index,
                  denomination: index === 1 ? 'sp' : 'gp',
                },
                rarities: index === 250 ? ['rare', 'veryRare'] : [index < 130 ? 'common' : 'rare'],
                quantity: 1,
              },
              flags: { mcpTest: { secret: 'NEVER_PUBLIC_ITEM_FLAG' } },
            }));
            // Foundry does not guarantee bulk creation response order.
            const items = (await Item.createDocuments(docs)).sort((left, right) =>
              left.name.localeCompare(right.name),
            );
            // System creation defaults may replace zero; restore the fixture after validation.
            await items[0].update({ 'system.price.value': 0 });
            const actor = await Actor.create({ name: `${prefix} Owner`, type: 'npc' });
            const owned = (
              await actor.createEmbeddedDocuments('Item', [
                items[0].toObject(),
                items[1].toObject(),
                items[250].toObject(),
              ])
            ).sort((left, right) => left.name.localeCompare(right.name));
            for (const [index, item] of owned.entries()) {
              const source = items[[0, 1, 250][index]];
              await item.update({
                'system.price': source.toObject().system.price,
                'system.rarities': [...source.system.rarities],
              });
            }
            return {
              actorId: actor.id,
              items: items.map((item) => ({
                id: item.id,
                name: item.name,
                type: item.type,
                price: {
                  value: item.system.price.value,
                  denomination: item.system.price.denomination,
                },
                rarities: [...item.system.rarities],
              })),
              owned: owned.map((item, index) => ({
                id: item.id,
                worldId: items[[0, 1, 250][index]].id,
              })),
            };
          }, prefix);
      } else if (url.pathname === '/mutate') {
        const kind = url.searchParams.get('kind');
        if (!['world-edit', 'world-delete', 'owned-edit'].includes(kind))
          throw new Error('Invalid fixture mutation');
        result = await page.evaluate(
          async ({ prefix, kind, itemId, actorId }) => {
            const actor = game.actors.get(actorId);
            const item = kind === 'owned-edit' ? actor?.items.get(itemId) : game.items.get(itemId);
            if (
              !item?.name.startsWith(prefix) ||
              (kind === 'owned-edit' && !actor?.name.startsWith(prefix))
            )
              throw new Error('Owned fixture required');
            if (kind === 'world-delete') await item.delete();
            else
              await item.update({
                'system.price.value': 25,
                'system.price.denomination': 'cp',
                'system.rarities': ['veryRare'],
              });
            return { ok: true };
          },
          {
            prefix,
            kind,
            itemId: url.searchParams.get('itemId'),
            actorId: url.searchParams.get('actorId'),
          },
        );
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      console.error('Item fixture operation failed:', error.name);
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Item fixture operation failed' }));
    }
  });
});
server.listen(port, '127.0.0.1', () =>
  console.info(`Item fixture controller ready on 127.0.0.1:${port}`),
);
async function close() {
  server.close();
  await context.close();
}
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

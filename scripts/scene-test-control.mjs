/** Fixed spatial fixtures for the disposable local integration world. */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { authenticateFoundry } from '../dist/foundry/auth.js';

const baseUrl = process.env.FOUNDRY_URL?.replace(/\/$/, '');
const username = process.env.FOUNDRY_USERNAME;
if (!baseUrl || !username) throw new Error('Explicit Foundry test credentials are required');
const port = Number(process.env.FOUNDRY_SCENE_TEST_CONTROL_PORT ?? 3014);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid controller port');
const context = await chromium.launchPersistentContext(
  process.env.FOUNDRY_SCENE_TEST_PROFILE ?? join(tmpdir(), 'foundry-scene-browser-profile'),
  { headless: true, viewport: { width: 1366, height: 768 } },
);
await context.addInitScript(() => localStorage.setItem('core.noCanvas', 'true'));
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
const prefix = 'MCP Scene Issue 8';
const originalActive = await page.evaluate(prefix => {
  const scene = game.scenes.active;
  return scene && !scene.name.startsWith(prefix) ? scene.id : null;
}, prefix);
async function cleanup() {
  return page.evaluate(async ({ prefix, originalActive }) => {
    const original = game.scenes.get(originalActive);
    if (original) await original.activate();
    for (const [collection, documentClass] of [[game.scenes, Scene], [game.actors, Actor], [game.users, User]]) {
      const ids = collection.filter(document => document.name.startsWith(prefix)).map(document => document.id);
      if (ids.length) await documentClass.deleteDocuments(ids);
    }
    return { ok: true };
  }, { prefix, originalActive });
}
async function oracle() {
  return page.evaluate(prefix => {
    const users = [game.user, ...game.users.filter(user => user.name.startsWith(prefix))];
    const scenes = game.scenes.filter(scene => scene.name.startsWith(prefix));
    return {
      gmId: game.user.id,
      users: users.map(user => ({ id: user.id, name: user.name, role: user.role })),
      activeSceneId: game.scenes.active?.id ?? null,
      scenes: scenes.map(scene => ({
        id: scene.id, name: scene.name, width: scene.width, height: scene.height, padding: scene.padding,
        shiftX: scene.shiftX, shiftY: scene.shiftY,
        grid: { type: scene.grid.type, size: scene.grid.size, distance: scene.grid.distance, units: scene.grid.units },
        dimensions: Object.fromEntries(['width', 'height', 'size', 'sceneX', 'sceneY', 'sceneWidth', 'sceneHeight', 'distance', 'distancePixels', 'rows', 'columns'].map(key => [key, scene.dimensions[key]])),
        tokens: scene.tokens.map(token => ({ id: token.id, name: token.name, actorId: token.actorId,
          actorLink: token.actorLink, x: token.x, y: token.y, width: token.width, height: token.height,
          rotation: token.rotation, elevation: token.elevation, hidden: token.hidden, disposition: token.disposition,
          scaleX: token.texture.scaleX, scaleY: token.texture.scaleY,
        })),
        permissions: users.map(user => ({ userId: user.id,
          sceneVisible: scene.testUserPermission(user, 'OBSERVER'),
          tokenIds: scene.tokens.filter(token => scene.testUserPermission(user, 'OBSERVER')
            && (user.isGM || !token.hidden) && token.testUserPermission(user, 'OBSERVER')).map(token => token.id),
          actors: scene.tokens.map(token => ({ tokenId: token.id,
            visible: !!token.actor?.testUserPermission(user, 'OBSERVER'),
            level: token.getUserLevel(user), synthetic: !!token.actor?.isToken,
          })),
        })),
      })),
    };
  }, prefix);
}
let serial = Promise.resolve();
const server = createServer((request, response) => {
  serial = serial.then(async () => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/status' && url.pathname !== '/oracle' && request.method !== 'POST') {
        response.writeHead(405).end(); return;
      }
      await ready();
      let result;
      if (url.pathname === '/status') result = await page.evaluate(() => ({ world: game.world.id,
        version: game.version, system: game.system.id, systemVersion: game.system.version,
        modules: [...game.modules.values()].filter(module => module.active).map(module => ({ id: module.id, version: module.version })),
      }));
      else if (url.pathname === '/oracle') result = await oracle();
      else if (url.pathname === '/cleanup' || url.pathname === '/seed') {
        result = await cleanup();
        if (url.pathname === '/seed') {
          await page.evaluate(async prefix => {
            const users = await User.createDocuments([
              { name: `${prefix} Player A`, role: 1, password: '' },
              { name: `${prefix} Player B`, role: 1, password: '' },
            ]);
            const a = users.find(user => user.name === `${prefix} Player A`);
            const b = users.find(user => user.name === `${prefix} Player B`);
            const actors = await Actor.createDocuments([
              { name: `${prefix} Shared Actor`, type: 'npc', ownership: { default: 2 } },
              { name: `${prefix} Actor A`, type: 'npc', ownership: { default: 0, [a.id]: 2 } },
              { name: `${prefix} Actor B`, type: 'npc', ownership: { default: 0, [b.id]: 2 } },
            ]);
            const shared = actors.find(actor => actor.name === `${prefix} Shared Actor`);
            const actorA = actors.find(actor => actor.name === `${prefix} Actor A`);
            const actorB = actors.find(actor => actor.name === `${prefix} Actor B`);
            const scenes = await Scene.createDocuments(Array.from({ length: 6 }, (_, type) => ({
              name: `${prefix} Grid ${type}`, width: 1234, height: 987, padding: type === 0 ? 0 : 0.2,
              shiftX: 30, shiftY: -25,
              grid: { type, size: 100, distance: 5, units: 'ft' }, ownership: { default: 2 },
              flags: { mcpTest: { secret: 'NEVER_PUBLIC_SCENE_FLAG' } },
            })));
            const square = scenes.find(scene => scene.grid.type === 1);
            await Scene.createDocuments([
              { name: `${prefix} Empty`, width: 1000, height: 800, padding: 0, grid: { type: 1, size: 100, distance: 5, units: 'ft' }, ownership: { default: 2 } },
              { name: `${prefix} Secret Scene`, width: 1000, height: 800, ownership: { default: 0 } },
              ...[0, 2, 3, 4, 5].map(type => ({
                name: `${prefix} ${type === 0 ? 'Padded Gridless' : `Zero Padding Hex ${type}`}`,
                width: 1234, height: 987, padding: type === 0 ? 0.2 : 0,
                shiftX: 30, shiftY: -25, grid: { type, size: 100, distance: 5, units: 'ft' },
                ownership: { default: 2 },
              })),
            ]);
            const token = (name, data = {}) => ({ name, actorId: shared.id, actorLink: true,
              x: -100, y: 0, width: 2, height: 0.5, rotation: 0, elevation: -5,
              texture: { src: 'icons/svg/mystery-man.svg', scaleX: 2, scaleY: 0.5 },
              flags: { mcpTest: { secret: 'NEVER_PUBLIC_TOKEN_FLAG' } }, ...data });
            await square.createEmbeddedDocuments('Token', [
              ...Array.from({ length: 251 }, (_, index) => token(index < 2 ? 'Duplicate 😀' : `Grid Token ${String(index).padStart(3, '0')}`, { x: index === 0 ? -100 : index * 10, y: index === 0 ? 0 : index * 5, elevation: index === 0 ? 0 : -5 })),
              token('Hidden Shared', { hidden: true }),
              token('Linked A', { actorId: actorA.id }), token('Linked B', { actorId: actorB.id }),
              token('Actorless', { actorId: null, actorLink: false }),
              token('Synthetic A', { actorId: actorA.id, actorLink: false }),
              token('Synthetic Override B', { actorId: actorA.id, actorLink: false, delta: { ownership: { default: 0, [b.id]: 2 } } }),
              token('Secret Disposition', { actorId: actorA.id, disposition: CONST.TOKEN_DISPOSITIONS.SECRET }),
            ]);
            for (const scene of scenes.filter(scene => scene !== square)) await scene.createEmbeddedDocuments('Token', [token(`Grid ${scene.grid.type} Token`)]);
            await square.activate();
          }, prefix);
          result = await oracle();
        }
      } else if (url.pathname === '/mutate') {
        const kind = url.searchParams.get('kind');
        if (!['token-edit', 'token-hide', 'token-delete', 'scene-edit', 'activate', 'actor-revoke', 'scene-revoke'].includes(kind)) throw new Error('Invalid fixture mutation');
        result = await page.evaluate(async ({ prefix, sceneId, tokenId, userId, kind }) => {
          const scene = game.scenes.get(sceneId);
          if (!scene?.name.startsWith(prefix)) throw new Error('Owned fixture scene required');
          const token = scene.tokens.get(tokenId);
          if (kind === 'activate') await scene.activate();
          else if (kind === 'scene-edit') await scene.update({ width: scene.width + 100 });
          else if (kind === 'scene-revoke') {
            if (!game.users.get(userId)?.name.startsWith(prefix)) throw new Error('Owned fixture user required');
            await scene.update({ [`ownership.${userId}`]: 0 });
          } else {
            if (!token) throw new Error('Owned fixture token required');
            if (kind === 'token-edit') await token.update({ x: token.x + 17, rotation: 45, elevation: 0 });
            else if (kind === 'token-hide') await token.update({ hidden: true });
            else if (kind === 'token-delete') await token.delete();
            else {
              const actor = game.actors.get(token.actorId);
              if (!actor?.name.startsWith(prefix) || !game.users.get(userId)?.name.startsWith(prefix)) throw new Error('Owned fixture actor and user required');
              await actor.update({ [`ownership.${userId}`]: 0 });
            }
          }
          return { ok: true };
        }, { prefix, sceneId: url.searchParams.get('sceneId'), tokenId: url.searchParams.get('tokenId'), userId: url.searchParams.get('userId'), kind });
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      console.error('Scene fixture operation failed:', error.name);
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Scene fixture operation failed' }));
    }
  });
});
server.listen(port, '127.0.0.1', () => console.info(`Scene fixture controller ready on 127.0.0.1:${port}`));
async function close() { server.close(); await context.close(); }
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

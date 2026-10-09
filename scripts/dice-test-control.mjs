/** Controlled official Foundry dice oracle for the disposable local test world. */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { authenticateFoundry } from '../dist/foundry/auth.js';

const baseUrl = process.env.FOUNDRY_URL?.replace(/\/$/, '');
const username = process.env.FOUNDRY_USERNAME;
if (!baseUrl || !username) throw new Error('Explicit Foundry test credentials are required');
const port = Number(process.env.FOUNDRY_DICE_TEST_CONTROL_PORT ?? 3015);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid controller port');
const context = await chromium.launchPersistentContext(
  process.env.FOUNDRY_DICE_TEST_PROFILE ?? join(tmpdir(), 'foundry-dice-browser-profile'),
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
let serial = Promise.resolve();
const server = createServer((request, response) => {
  serial = serial.then(async () => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      await ready();
      let result;
      if (url.pathname === '/status' && request.method === 'GET') {
        result = await page.evaluate(() => ({ world: game.world.id, version: game.version,
          system: game.system.id, systemVersion: game.system.version,
          modules: [...game.modules.values()].filter(module => module.active).map(module => ({ id: module.id, version: module.version })),
          randomSource: typeof CONFIG.Dice.randomUniform,
          chatMessageCount: game.messages.size,
        }));
      } else if (url.pathname === '/roll' && request.method === 'POST') {
        let text = '';
        for await (const chunk of request) {
          text += chunk;
          if (Buffer.byteLength(text) > 16_384) throw new Error('Oracle input exceeds capacity');
        }
        const input = JSON.parse(text);
        if (typeof input.formula !== 'string' || input.formula.length > 100 || !Array.isArray(input.uniforms)
          || input.uniforms.length > 1000 || input.uniforms.some(value => !Number.isFinite(value) || value < 0 || value >= 1)) {
          throw new Error('Invalid bounded oracle input');
        }
        result = await page.evaluate(async ({ formula, uniforms }) => {
          if (typeof CONFIG.Dice.randomUniform !== 'function') throw new Error('Official RNG hook unavailable');
          const original = CONFIG.Dice.randomUniform;
          let consumed = 0;
          CONFIG.Dice.randomUniform = () => {
            if (consumed >= uniforms.length) throw new Error('Controlled RNG fixture exhausted');
            return uniforms[consumed++];
          };
          try {
            const roll = new Roll(formula);
            await roll.evaluate();
            return { formula: roll.formula, total: roll.total, consumed,
              dice: roll.dice.map(die => ({ faces: die.faces,
                results: die.results.map(outcome => ({ result: outcome.result, active: outcome.active })),
              })),
            };
          } catch (error) {
            return { error: String(error.message), consumed };
          } finally { CONFIG.Dice.randomUniform = original; }
        }, input);
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      console.error('Dice oracle operation failed:', error.name);
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Dice oracle operation failed' }));
    }
  });
});
server.listen(port, '127.0.0.1', () => console.info(`Dice oracle controller ready on 127.0.0.1:${port}`));
async function close() { server.close(); await context.close(); }
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

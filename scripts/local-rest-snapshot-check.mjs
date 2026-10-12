/** Destructive integration check: disposable test1world and its local fixture controller only. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv from 'ajv';
import { FoundryClient } from '../dist/foundry/client.js';
import { FoundryMCPServer } from '../dist/index.js';
import { sortCollectionRecords } from '../dist/foundry/pagination.js';

const credentialFile = process.env.FOUNDRY_REST_FIXTURE_CREDENTIALS;
assert.ok(credentialFile, 'Set FOUNDRY_REST_FIXTURE_CREDENTIALS to the private fixture credentials file');
const auth = JSON.parse(await readFile(credentialFile, 'utf8'));
const passed = [];
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat('date-time', value => !Number.isNaN(Date.parse(value)));
async function control(path, body = {}) {
  const response = await fetch(`http://127.0.0.1:3011${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, 'Local fixture controller failed');
  return response.json();
}
async function session(role) {
  const server = new FoundryMCPServer({ foundryClient: new FoundryClient({
    baseUrl: 'http://127.0.0.1:3010', apiKey: auth.roleKeys[role].key,
    allowPrivilegedAccount: true, retryAttempts: 1, retryDelay: 1,
  }) });
  const client = new Client({ name: 'local-rest-snapshot-check', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.start(serverTransport);
    await client.connect(clientTransport);
    const schemas = new Map((await client.listTools()).tools.map(tool => [tool.name, tool.outputSchema]));
    return {
      async tool(name, args) {
        const response = await client.callTool({ name, arguments: args });
        assert.notEqual(response.isError, true, `${name} returned an error`);
        assert.ok(schemas.get(name), `${name} output schema missing`);
        assert.ok(ajv.validate(schemas.get(name), response.structuredContent), `${name} schema mismatch`);
        assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 128 * 1024, 'MCP response exceeded budget');
        return response.structuredContent;
      },
      async error(name, args) {
        let failed = false;
        try { failed = (await client.callTool({ name, arguments: args })).isError === true; }
        catch { failed = true; }
        assert.ok(failed, `${name} unexpectedly succeeded`);
      },
      async resource(uri) {
        const response = await client.readResource({ uri });
        assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 128 * 1024, 'Resource exceeded budget');
        return JSON.parse(response.contents[0].text);
      },
      async close() { await client.close(); await server.shutdown(); },
    };
  } catch (error) {
    await client.close(); await server.shutdown(); throw error;
  }
}
function record(name) { passed.push(name); console.log(`PASS ${name}`); }
async function traverse(client, name, args) {
  const first = await client.tool(name, args);
  const records = [...first.records];
  let page = first;
  while (page.nextCursor) {
    const next = await client.tool(name, { ...args, cursor: page.nextCursor });
    assert.equal(next.snapshotId, first.snapshotId);
    assert.equal(next.total, first.total);
    assert.equal(next.page, page.page + 1);
    records.push(...next.records); page = next;
  }
  assert.equal(records.length, first.total);
  assert.equal(new Set(records.map(value => value.id)).size, first.total);
  return { first, records };
}
try {
  const fixtures = await control('/collections-fixtures', { count: 251 });
  for (const role of ['player', 'trusted', 'assistant', 'gm']) {
    const client = await session(role);
    try {
      const world = await client.resource('foundry://world/settings');
      assert.equal(world.world.id, 'test1world', 'Checks require disposable test1world');
      const privileged = ['assistant', 'gm'].includes(role);
      const actors = await traverse(client, 'search_actors', { query: 'MCP Snapshot', limit: 1 });
      assert.equal(actors.first.total, privileged ? 5 : 2);
      const items = await traverse(client, 'search_items', { query: 'MCP Snapshot Paging', limit: 10 });
      assert.equal(items.first.total, 251);
      const ids = items.records.map(value => value.id);
      assert.deepEqual(ids, sortCollectionRecords(items.records).map(value => value.id),
        'Names, types and duplicate ID tie-breakers must remain ordered');
      const visible = await traverse(client, 'search_items', { query: 'MCP Snapshot', limit: 10 });
      assert.equal(visible.first.total, privileged ? 257 : 252);
      assert.equal(visible.records.some(value => value.id === fixtures.hiddenItem), privileged);
      assert.equal(visible.records.some(value => value.id === fixtures.limitedItem), privileged);
      await client.tool('get_actor_details', { actorId: fixtures.records[role].actor });
      await client.tool('get_item_details', { itemId: fixtures.records[role].item });
      if (!privileged) {
        await client.error('get_actor_details', { actorId: fixtures.records.gm.actor });
        await client.error('get_item_details', { itemId: fixtures.hiddenItem });
      }
      for (const collection of ['actors', 'items']) {
        let page = await client.resource(`foundry://${collection}?limit=10`);
        const total = page.total; const resourceIds = page.records.map(value => value.id);
        while (page.nextUri) {
          const next = await client.resource(page.nextUri);
          assert.equal(next.snapshotId, page.snapshotId); assert.equal(next.total, total);
          resourceIds.push(...next.records.map(value => value.id)); page = next;
        }
        assert.equal(resourceIds.length, total);
        assert.equal(new Set(resourceIds).size, total);
        for (const id of resourceIds) {
          if (!privileged && collection === 'items') assert.notEqual(id, fixtures.hiddenItem);
        }
      }
      await client.error('search_items', { query: 'different', limit: 10, cursor: items.first.nextCursor });
      await client.error('search_items', { query: 'MCP Snapshot Paging', limit: 100 });
      await client.error('search_items', { limit: 101 });
      record(`${role}: tools, schemas, details, resources, authorized totals and 251 duplicate names`);
    } finally { await client.close(); }
  }
  const client = await session('player');
  try {
    for (const action of ['create', 'update', 'delete']) {
      const first = await client.tool('search_items', { query: 'MCP Snapshot Paging', limit: 10 });
      const resource = await client.resource('foundry://items?limit=10');
      await control('/collections-mutate', { collection: 'items', action, id: first.records[0].id });
      await client.error('search_items', { query: 'MCP Snapshot Paging', limit: 10, cursor: first.nextCursor });
      await assert.rejects(client.resource(resource.nextUri));
      record(`${action}: MCP tool and resource cursors reject invalidation`);
    }
    const first = await client.tool('search_items', { query: 'MCP Snapshot', limit: 10 });
    await control('/collections-mutate', { collection: 'items', id: fixtures.records.player.item,
      update: { ownership: { default: 0, [auth.roleKeys.player.userId]: 0 } },
    });
    await client.error('search_items', { query: 'MCP Snapshot', limit: 10, cursor: first.nextCursor });
    await client.error('get_item_details', { itemId: fixtures.records.player.item });
    const fresh = await traverse(client, 'search_items', { query: 'MCP Snapshot Owned player', limit: 10 });
    assert.equal(fresh.first.total, 0);
    record('permission revocation: cached MCP cursor denied, fresh totals and details updated');
    const reconnect = await client.tool('search_items', { query: 'MCP Snapshot Paging', limit: 10 });
    await control('/disconnect'); await control('/reconnect');
    await client.error('search_items', { query: 'MCP Snapshot Paging', limit: 10, cursor: reconnect.nextCursor });
    record('reconnect: cached MCP cursor denied');
    for (const count of [0, 1, 100, 101, 251]) {
      await control('/collections-fixtures', { count });
      const result = await traverse(client, 'search_items', { query: 'MCP Snapshot Paging', limit: 10 });
      assert.equal(result.first.total, count);
      record(`MCP exact traversal cardinality ${count}`);
    }
  } finally { await client.close(); }
  if (process.env.FOUNDRY_REST_RESULT_FILE) await writeFile(process.env.FOUNDRY_REST_RESULT_FILE,
    JSON.stringify({ target: '127.0.0.1:30001/test1world', foundry: '14.369', system: 'dnd5e 6.0.6', passed }, null, 2) + '\n');
} catch (error) {
  // Avoid rendering SDK/HTTP objects, which can carry credentials.
  console.error(`Local REST MCP integration failed: ${error instanceof Error ? error.name : 'unknown error'}`);
  if (error instanceof assert.AssertionError) console.error(error.message);
  if (error instanceof Error) console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).join('\n'));
  process.exitCode = 1;
}

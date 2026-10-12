/** Disposable local test1world controller. Credentials are supplied through private files. */
import { readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
assert.ok(process.env.FOUNDRY_FIXTURE_ENV, 'Set FOUNDRY_FIXTURE_ENV to a private local Foundry env file');
assert.ok(process.env.FOUNDRY_REST_FIXTURE_CREDENTIALS, 'Set FOUNDRY_REST_FIXTURE_CREDENTIALS outside the repository');
const env = dotenv.parse(await readFile(process.env.FOUNDRY_FIXTURE_ENV));
const target = new URL(env.FOUNDRY_URL || 'http://127.0.0.1:30001');
assert.equal(target.origin, 'http://127.0.0.1:30001', 'Only the local disposable server is supported');
Object.assign(process.env, env, {LOG_LEVEL:'error'});
const {authenticateFoundry} = await import('../dist/foundry/auth.js');
const secretPath = process.env.FOUNDRY_REST_FIXTURE_CREDENTIALS;
const relay = 'http://127.0.0.1:3010';
let auth;
try { auth = JSON.parse(await readFile(secretPath, 'utf8')); } catch { auth = {}; }
async function request(path, body, session = true, method = 'POST') {
  const response = await fetch(relay + path, {method, headers: {'content-type':'application/json', ...(session && auth.sessionToken && {authorization:'Bearer '+auth.sessionToken})}, ...(body !== undefined && {body:JSON.stringify(body)})});
  if (!response.ok) throw new Error(`Local relay request ${path} failed: ${response.status}`);
  return response.status === 204 ? {} : response.json();
}
async function save() { await writeFile(secretPath, JSON.stringify(auth), {mode:0o600}); await chmod(secretPath, 0o600); }
if (!auth.sessionToken) {
  const account = {email:'mcp-'+randomBytes(6).toString('hex')+'@example.com', password:'Aa1!'+randomBytes(20).toString('hex')};
  auth = {...account, ...await request('/auth/register', account, false)};
  await save();
}
const profile = await mkdtemp(join(tmpdir(), 'foundry-rest-fixture-'));
const context = await chromium.launchPersistentContext(profile, {headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined, args:['--disable-dev-shm-usage']});
async function cleanup() { await context.close(); await rm(profile, {recursive:true, force:true}); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit()); });
await context.addInitScript(() => localStorage.setItem('core.noCanvas', 'true'));
const baseUrl = (env.FOUNDRY_URL || 'http://127.0.0.1:30001').replace(/\/$/, '');
const session = await authenticateFoundry(baseUrl, env.FOUNDRY_USERNAME ?? 'Gamemaster', env.FOUNDRY_PASSWORD ?? '');
await context.addCookies([{name:'session',value:session.session,url:baseUrl}]);
const page = context.pages()[0] ?? await context.newPage();
page.on('dialog', d => d.dismiss().catch(()=>{}));
async function ready() { await page.waitForFunction(() => globalThis.game?.ready === true, null, {timeout:90_000}); }
await page.goto((env.FOUNDRY_URL || 'http://127.0.0.1:30001').replace(/\/$/, '')+'/game', {waitUntil:'domcontentloaded',timeout:60000});
if (await page.locator('#login-form').count()) {
  const value = await page.locator('select[name="userid"]').evaluate((select, username) => [...select.options].find(o=>o.text.trim() === username)?.value, env.FOUNDRY_USERNAME ?? 'Gamemaster');
  if (!value) throw new Error('Test Gamemaster login option is unavailable');
  await page.locator('select[name="userid"]').selectOption(value);
  await page.locator('input[name="password"]').fill(env.FOUNDRY_PASSWORD ?? '');
  await page.locator('button[data-action="join"]').click();
}
await ready();
const world = await page.evaluate(() => ({id:game.world.id,title:game.world.title,version:game.version,system:game.system.version}));
if (world.id !== 'test1world') throw new Error('Unexpected test world');
const enabled = await page.evaluate(() => game.modules.get('foundry-rest-api')?.active === true);
if (!enabled) {
  await page.evaluate(async()=> {const conf=game.settings.get('core','moduleConfiguration'); await game.settings.set('core','moduleConfiguration',{...conf,'foundry-rest-api':true});});
  await page.reload(); await ready();
}
if (!auth.connectionToken) {
  const fingerprint = await page.evaluate(async()=> {let f=game.settings.get('foundry-rest-api','serverFingerprint'); if(!f){f=crypto.randomUUID();await game.settings.set('foundry-rest-api','serverFingerprint',f);}return f;});
  const code = await request('/auth/connection-tokens/', {});
  const pair = await request('/auth/pair', {code:code.code,worldId:world.id,worldTitle:world.title,serverFingerprint:fingerprint,serverOrigin:'http://127.0.0.1:30001'}, false);
  auth.clientId = pair.clientId; auth.connectionToken = pair.token; auth.relayUrl=pair.relayUrl;
  const key = await request('/auth/api-keys/', {name:'MCP integration tests',scopes:['search','entity:read'],scopedClientId:pair.clientId});
  auth.apiKey=key.key; auth.apiKeyId=key.id;
  const readless = await request('/auth/api-keys/', {name:'MCP search-only negative test',scopes:['search'],scopedClientId:pair.clientId});
  auth.searchOnlyKey=readless.key;auth.searchOnlyKeyId=readless.id;
  await save();
}
await page.evaluate(async ({clientId,connectionToken})=> {
  for (const [key,value] of Object.entries({wsRelayUrl:'ws://127.0.0.1:3010',pairedRelayUrl:'ws://127.0.0.1:3010',clientId,connectionToken})) await game.settings.set('foundry-rest-api',key,value);
}, auth);
await page.reload(); await ready();
async function connected() { await page.waitForFunction(()=>game.modules.get('foundry-rest-api')?.api?.isRelayConnected(), null, {timeout:60_000}); }
await connected();
// Test credentials stay in the private fixture file, outside all repositories.
const identities = await page.evaluate(async()=> {
  const result={};
  for (const [label,role] of Object.entries({player:1,trusted:2,assistant:3,gm:4})) {
    let user=game.users.find(u=>u.name==='MCP Snapshot '+label);
    if(!user) user=await User.create({name:'MCP Snapshot '+label,role,password:crypto.randomUUID()});
    result[label]={id:user.id,role};
  }
  return result;
});
auth.roleKeys ??= {};
for(const [label,user] of Object.entries(identities)) {
  if(!auth.roleKeys[label]) {
    const key=await request('/auth/api-keys/', {name:'Local snapshot '+label,scopes:['search','entity:read'],scopedClientId:auth.clientId,scopedUserId:user.id});
    auth.roleKeys[label]={key:key.key,id:key.id,userId:user.id,role:user.role};
  }
}
auth.unboundKey ??= auth.apiKey;
auth.apiKey=auth.roleKeys.gm.key;
auth.apiKeyId=auth.roleKeys.gm.id;
await save();
let serial=Promise.resolve();
const server=createServer((req,res)=> {
  serial=serial.then(async()=> {
    try {
      const url = new URL(req.url,'http://127.0.0.1');
      const path = url.pathname;
      if (req.headers.origin || req.headers.host !== '127.0.0.1:3011' || (req.method === 'POST' && req.headers['content-type'] !== 'application/json')) {res.writeHead(403);res.end();return;}
      if (await page.evaluate(() => game.world?.id) !== 'test1world') throw new Error('Unexpected test world');
      let body={};
      if(req.method==='POST') {let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)throw new Error('Request too large');}body=raw?JSON.parse(raw):{};}
      let result;
      if(path==='/status') result=await page.evaluate(()=>({world:game.world.id,version:game.version,moduleVersion:game.modules.get('foundry-rest-api').version,connected:game.modules.get('foundry-rest-api').api?.isRelayConnected()??false,pack:game.packs.has('world.mcp-capability-fixtures')}));
      else if(req.method!=='POST') {res.writeHead(405);res.end();return;}
      else if(path==='/collections-fixtures') {
        const count=body.count??251;
        if(!Number.isInteger(count)||count<0||count>10001)throw new Error('Invalid fixture count');
        const large=body.large??0;
        if(!Number.isInteger(large)||large<0||large>100000)throw new Error('Invalid fixture size');
        result=await page.evaluate(async({count,identities,large})=> {
          for(const collection of [game.actors,game.items]) {
            const ids=collection.filter(d=>d.flags?.['mcp-snapshot-test']?.fixture).map(d=>d.id);
            if(ids.length)await collection.documentClass.deleteDocuments(ids);
          }
          const users=Object.values(identities).map(u=>u.id);
          const ownership={default:2,...Object.fromEntries(users.map(id=>[id,2]))};
          const data=Array.from({length:count},(_,i)=>({name:`MCP Snapshot Paging ${String(Math.floor(i/2)).padStart(5,'0')}`,type:'spell',ownership,flags:{'mcp-snapshot-test':{fixture:true,index:i}},...(large&&{system:{description:{value:'x'.repeat(large)}}})}));
          for(let i=0;i<data.length;i+=100) await Item.createDocuments(data.slice(i,i+100));
          const records={};
          for(const [label,user] of Object.entries(identities)) {
            const owned={default:0,[user.id]:3};
            const actor=await Actor.create({name:'MCP Snapshot Owned '+label,type:'character',ownership:owned,flags:{'mcp-snapshot-test':{fixture:true}},items:[{name:'MCP Snapshot Embedded '+label,type:'spell'}]});
            const item=await Item.create({name:'MCP Snapshot Owned '+label,type:'spell',ownership:owned,flags:{'mcp-snapshot-test':{fixture:true}}});
            records[label]={actor:actor.id,item:item.id};
          }
          const sharedActor=await Actor.create({name:'MCP Snapshot Shared',type:'character',ownership,flags:{'mcp-snapshot-test':{fixture:true}}});
          const hiddenItem=await Item.create({name:'MCP Snapshot Hidden',type:'spell',ownership:{default:0},flags:{'mcp-snapshot-test':{fixture:true}}});
          const limitedItem=await Item.create({name:'MCP Snapshot Limited',type:'spell',ownership:{default:1},flags:{'mcp-snapshot-test':{fixture:true}}});
          return {count,records,sharedActor:sharedActor.id,hiddenItem:hiddenItem.id,limitedItem:limitedItem.id};
        },{count,identities,large});
      }
      else if(path==='/collections-mutate') {
        result=await page.evaluate(async body=> {
          const collection=body.collection==='actors'?game.actors:game.items;
          if(body.action==='create') {const doc=await collection.documentClass.create({name:'MCP Snapshot Concurrent',type:body.collection==='actors'?'character':'spell',ownership:{default:2},flags:{'mcp-snapshot-test':{fixture:true}}});return {id:doc.id};}
          const doc=collection.get(body.id);if(!doc?.flags?.['mcp-snapshot-test']?.fixture)throw new Error('Missing fixture');
          if(body.action==='delete')await doc.delete();else await doc.update(body.update??{name:'MCP Snapshot Updated'});
          return {ok:true};
        },body);
      }
      else if(path==='/disconnect') {await page.evaluate(()=>game.modules.get('foundry-rest-api').api.getWebSocketManager()?.disconnect());result={ok:true};}
      else if(path==='/reconnect') {await page.evaluate(()=>game.modules.get('foundry-rest-api').api.getWebSocketManager()?.connect());await connected();result={ok:true};}
      else if(path==='/disable'||path==='/enable') {
        await page.evaluate(async(on)=>{const conf=game.settings.get('core','moduleConfiguration');await game.settings.set('core','moduleConfiguration',{...conf,'foundry-rest-api':on});},path==='/enable');
        await page.reload();await ready();if(path==='/enable')await connected();result={ok:true};
      }
      else if(path==='/reload') {await page.reload();await ready();await connected();result={ok:true};}
      else if(path==='/seed'||path==='/seed-paging') {
        const count=path==='/seed'?3:Number(url.searchParams.get('count'));
        if(!Number.isInteger(count)||count<1||count>251)throw new Error('Invalid fixture count');
        result=await page.evaluate(async({paging,count})=> {
          let pack=game.packs.get('world.mcp-capability-fixtures');
          if(pack)await pack.deleteCompendium();
          pack=await CompendiumCollection.createCompendium({name:'mcp-capability-fixtures',label:'MCP capability fixtures',type:'Item',package:'world'});
          const documents=paging?Array.from({length:count},(_,i)=>({name:`MCP Capability Paging ${String(i).padStart(3,'0')}`,type:'spell',system:{level:i%3,school:'evo',source:{rules:'2024',custom:'MCP Paging Fixture'}}})):[
            {name:'MCP Capability Alpha',type:'spell',system:{level:1,school:'evo',source:{rules:'2014',custom:'MCP Fixture'}}},
            {name:'MCP Capability Beta',type:'spell',system:{level:2,school:'abj',source:{rules:'2024',custom:'MCP Fixture'}}},
            {name:'MCP Capability Gamma',type:'spell',system:{level:1,school:'evo',source:{rules:'2014',custom:'Other Fixture'}}}
          ];
          await Item.createDocuments(documents,{pack:pack.collection});
          return {pack:pack.collection,count};
        },{paging:path==='/seed-paging',count});
        await page.reload();await ready();await connected();
      }
      else if(path==='/cleanup') {await page.evaluate(async()=>{const pack=game.packs.get('world.mcp-capability-fixtures');if(pack)await pack.deleteCompendium();});await page.reload();await ready();await connected();result={ok:true};}
      else {res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'Local browser control operation failed'}));console.error('Local browser control operation failed:',error.name);}
  });
});
server.listen(3011,'127.0.0.1');
console.log(JSON.stringify({ready:true,...world,relay,control:'http://127.0.0.1:3011'}));

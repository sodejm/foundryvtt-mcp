#!/usr/bin/env node
/** Linux/OpenSSH qualification with a packed release and synthetic REST credentials. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'foundry-ssh-'));
chmodSync(temporary, 0o700);
const name = `foundry-ssh-${randomBytes(6).toString('hex')}`;
const image = `${name}:test`;
const key = join(temporary, 'identity');
const knownHosts = join(temporary, 'known_hosts');
let containerCreated = false;
let sshArgs;
let client;
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 240000,
    maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const docker = (...args) => command('docker', args);
function ssh(remote, input, extra = []) {
  return spawnSync('ssh', [...sshArgs, ...extra, 'foundry-mcp@127.0.0.1', remote], {
    input, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
}
function success(result) {
  assert.equal(result.status, 0, `${result.error?.message ?? ''} ${result.stderr}`);
  return result.stdout;
}
function denied(result) {
  assert.notEqual(result.status, 0, 'Forbidden operation unexpectedly succeeded');
  assert.equal(result.error, undefined, 'Denial must complete, not time out');
}
function cleanup() {
  client?.kill('SIGTERM');
  if (containerCreated) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30000 });
  spawnSync('docker', ['image', 'rm', image], { stdio: 'ignore', timeout: 30000 });
  rmSync(temporary, { recursive: true, force: true });
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => { cleanup(); process.exit(1); });
}
try {
  console.log('Building isolated Linux SSH qualification fixture');
  docker('build', '-t', image, '-f', 'deploy/remote-stdio/lab.Dockerfile', 'deploy/remote-stdio');
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const artifact = readFileSync(join(temporary, packed[0].filename));
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  const digest = createHash('sha256').update(artifact).digest('hex');
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::22', image);
  containerCreated = true;
  docker('cp', `${key}.pub`, `${name}:/etc/ssh/foundry-mcp.keys`);
  docker('exec', name, 'chown', 'root:root', '/etc/ssh/foundry-mcp.keys');
  docker('exec', name, 'chmod', '644', '/etc/ssh/foundry-mcp.keys');
  docker('exec', name, '/usr/sbin/sshd', '-t');
  const policy = docker('exec', name, '/usr/sbin/sshd', '-T', '-C', 'user=foundry-mcp,host=localhost,addr=127.0.0.1');
  for (const expected of ['disableforwarding yes', 'permittty no', 'permituserrc no',
    'passwordauthentication no', 'kbdinteractiveauthentication no', 'authenticationmethods publickey',
    'forcecommand /usr/local/libexec/foundry-mcp-ssh', 'authorizedkeysfile /etc/ssh/foundry-mcp.keys']) {
    assert.ok(policy.includes(expected), `Missing SSH policy: ${expected}`);
  }
  const port = docker('port', name, '22/tcp').split(':').at(-1);
  // Trusted host key comes directly from the owned fixture, never unauthenticated ssh-keyscan.
  const hostKey = docker('exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub');
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });
  sshArgs = ['-T', '-p', port, '-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=10'];
  success(ssh(`install ${version} ${digest}`, artifact));
  denied(ssh(`install ${version} ${'0'.repeat(64)}`, artifact));
  denied(ssh(`install 0.0.0 ${digest}`, artifact));
  const fixtureConfig = (apiKey) => Buffer.from(`FOUNDRY_URL=http://127.0.0.1:30000\nFOUNDRY_API_KEY=${apiKey}\nFOUNDRY_ALLOW_PRIVILEGED_ACCOUNT=true\nFOUNDRY_WRITE_ENABLED=false\nNODE_ENV=test\n`);
  success(ssh('configure', fixtureConfig('remote-stdio-fixture-key')));
  const identity = JSON.parse(success(ssh('verify')));
  assert.ok(identity.uid > 0 && identity.gid > 0);
  assert.deepEqual(identity.groups, [identity.gid]);
  assert.equal(identity.homeMode, '0o700');
  assert.equal(identity.configMode, '0o700');
  assert.equal(identity.credentialMode, '0o600');
  console.log('Dedicated UID/GID and private home/config/credentials verified');
  const forbidden = [
    ['unrelated', 'cat', '/srv/foundry-mcp/config/.env'],
    ['foundry-mcp', 'cat', '/home/unrelated/private'],
    ['foundry-mcp', 'cat', '/opt/unrelated-app/private'],
    ['foundry-mcp', 'touch', '/etc/foundry-mcp-denied'],
    ['foundry-mcp', 'test', '-w', '/etc/ssh/foundry-mcp.keys'],
    ['foundry-mcp', 'test', '-w', '/usr/local/libexec/foundry-mcp-ssh'],
    ['foundry-mcp', 'test', '-e', '/var/run/docker.sock'],
  ];
  for (const [user, ...args] of forbidden) {
    denied(spawnSync('docker', ['exec', '--user', user, name, ...args], { encoding: 'utf8', timeout: 10000 }));
  }
  for (const remote of ['id', 'sh', 'run; id', 'scp -t /srv/foundry-mcp', 'install latest anything']) denied(ssh(remote));
  denied(ssh('sftp', undefined, ['-s']));
  denied(ssh('verify', undefined, ['-tt']));
  denied(ssh('run', undefined, ['-N', '-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:0:127.0.0.1:22']));
  console.log('Unrelated-file/privilege access, shell, subsystem, PTY and forwarding denied');
  docker('cp', 'deploy/remote-stdio/lab-fixture.py', `${name}:/tmp/fixture.py`);
  docker('exec', '-d', '--user', 'unrelated', name, 'python3', '/tmp/fixture.py');
  client = spawn('ssh', [...sshArgs, 'foundry-mcp@127.0.0.1', 'run'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(client, 'close');
  let output = '';
  let diagnostics = '';
  let buffer = '';
  let protocolError;
  const pending = new Map();
  client.stdout.on('data', (chunk) => {
    output += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        assert.equal(frame.jsonrpc, '2.0');
        pending.get(frame.id)?.(frame);
      } catch (error) { protocolError = error; }
    }
  });
  client.stderr.on('data', (chunk) => { diagnostics += chunk; });
  async function request(id, method, params) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 15000);
      pending.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    });
    client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }
  assert.ok((await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'remote-stdio-check', version: '1' } })).result?.serverInfo);
  client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.ok((await request(2, 'tools/list', {})).result?.tools.length);
  assert.equal((await request(3, 'tools/call', { name: 'roll_dice',
    arguments: { formula: '1d1', engine: 'local' } })).result?.structuredContent?.total, 1);
  denied(ssh('configure', fixtureConfig('changed')));
  denied(ssh(`install ${version} ${digest}`, artifact));
  denied(ssh('remove'));
  success(ssh('stop'));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Remote stop timeout')), 10000))]);
  client = undefined;
  assert.ifError(protocolError);
  assert.equal(buffer, '');
  assert.ok(diagnostics.includes('FoundryVTT MCP Server starting'));
  assert.ok(!output.includes('remote-stdio-fixture-key') && !diagnostics.includes('remote-stdio-fixture-key'));
  console.log('Remote MCP initialize, tools/list, local dice and stop passed; stdout is protocol-only');
  // Reconfigure an invalid application key: SSH still works but MCP cannot start.
  success(ssh('configure', fixtureConfig('revoked-fixture-key')));
  denied(ssh('run'));
  success(ssh('verify'));
  success(ssh('configure', fixtureConfig('remote-stdio-fixture-key')));
  // Key revocation is independent of the persisted Foundry credentials.
  docker('exec', name, 'truncate', '-s', '0', '/etc/ssh/foundry-mcp.keys');
  denied(ssh('verify'));
  docker('cp', `${key}.pub`, `${name}:/etc/ssh/foundry-mcp.keys`);
  docker('exec', name, 'chown', 'root:root', '/etc/ssh/foundry-mcp.keys');
  docker('exec', name, 'chmod', '644', '/etc/ssh/foundry-mcp.keys');
  success(ssh('verify'));
  success(ssh('remove'));
  for (const path of ['app', 'cache', 'config']) {
    denied(spawnSync('docker', ['exec', name, 'test', '-e', `/srv/foundry-mcp/${path}`], { encoding: 'utf8' }));
  }
  console.log('Independent credential/key revocation and clean unprivileged removal passed');
} catch (error) {
  if (containerCreated) {
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
    console.error(logs.stdout, logs.stderr);
  }
  throw error;
} finally {
  cleanup();
}
